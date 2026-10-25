// 真实 Generate 入口的单一接线：激活 + 清单声明 + 每请求最多一次派发。
import { activate, beginRequestEpoch as beginPromptRequestEpoch, endRequestEpoch as endPromptRequestEpoch } from './prompt-runtime.js';
import { beginRequestEpoch as beginDepthRequestEpoch, endRequestEpoch as endDepthRequestEpoch, clearReorderMap, restoreRegisteredInChatPrompts, sweepRegisteredInChatPrompts, markRequestIntercepted, wasRequestIntercepted, reorderMapStatus, worldInfoDepthBridgeStatus } from './depth-bridge.js';

export const INTERCEPTOR_KEY = 'deathReturnPromptInterceptorV1';
export const INTERCEPTOR_MANIFEST = Object.freeze({ display_name: 'Death Return Prompt Order', generate_interceptor: INTERCEPTOR_KEY, version: '0.1.0' });
const counts = { installAttempts: 0, activationCalls: 0, installFailures: 0, selfPathInvocations: 0, hostPathSkipped: 0, abortedByInterceptor: 0 };
let installation = null, adapter = null;
const dispatchState = new WeakMap();
const requestScopes = [];
let requestSerial = 0;

export function installDeathReturnPromptEntry(options = {}) {
    counts.installAttempts++;
    if (installation) return installation;
    adapter = { getRegistry: typeof options.getRegistry === 'function' ? options.getRegistry : () => null, isInChat: typeof options.isInChat === 'function' ? options.isInChat : () => false };
    try {
        counts.activationCalls++;
        activate(typeof options.lifecycle === 'function' ? options.lifecycle : null);
        installation = Object.freeze({ ok: true, code: 'DEATH_RETURN_ENTRY_INSTALLED', interceptorKey: INTERCEPTOR_KEY, manifest: INTERCEPTOR_MANIFEST });
    } catch (error) {
        installation = Object.freeze({ ok: false, code: String(error?.message ?? 'DEATH_RETURN_ENTRY_INSTALL_FAILED'), rolledBack: true });
        counts.installFailures++;
    }
    return installation;
}
export function deathReturnPromptEntryStatus() {
    return Object.freeze({ installation: installation ?? Object.freeze({ ok: false, code: 'DEATH_RETURN_ENTRY_NOT_INSTALLED' }), counts: Object.freeze({ ...counts }), reorder: reorderMapStatus(), worldInfoBridge: worldInfoDepthBridgeStatus() });
}
export function beginDeathReturnPromptRequest() {
    beginPromptRequestEpoch();
    beginDepthRequestEpoch();
    restoreRegisteredInChatPrompts();
    clearReorderMap('request-begin');
    const scope = Object.freeze({ id: ++requestSerial });
    requestScopes.push(scope);
    return scope;
}
export function endDeathReturnPromptRequest(scope = null) {
    const index = scope === null ? requestScopes.length - 1 : requestScopes.lastIndexOf(scope);
    if (index < 0) return false;
    requestScopes.splice(index, 1);
    endPromptRequestEpoch();
    endDepthRequestEpoch();
    restoreRegisteredInChatPrompts();
    clearReorderMap('request-end');
    return true;
}
// 投影成功后由 prompt-runtime 调用：发布映射（失败即不发布，深度换算保持原生行为）。
export function sweepRegisteredInChatPromptsForEntry() {
    return sweepRegisteredInChatPrompts(adapter?.getRegistry?.(), adapter?.isInChat);
}
// 宿主清单路径已调用过同一个全局拦截函数时跳过自派发；两条路径共用同一函数，每请求最多一次。
export async function runDeathReturnPromptInterceptorForRequest(coreChat, contextSize, type) {
    if (!Array.isArray(coreChat)) return false;
    const interceptor = globalThis[INTERCEPTOR_KEY];
    if (typeof interceptor !== 'function') return false;
    if (wasRequestIntercepted(coreChat)) { counts.hostPathSkipped++; return false; }
    counts.selfPathInvocations++;
    let aborted = false;
    try { await interceptor(coreChat, contextSize, () => { aborted = true; }, type); }
    catch { dispatchState.set(coreChat, 'runner-error'); return false; }
    if (aborted) counts.abortedByInterceptor++;
    dispatchState.set(coreChat, aborted ? 'aborted' : 'completed');
    return aborted;
}
export function deathReturnPromptDispatchState(coreChat) { return dispatchState.get(coreChat) ?? null; }
