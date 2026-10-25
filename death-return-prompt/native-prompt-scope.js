import { readNativePromptRequestSource } from '../native-prewait.js';
let installation = null;
let knownInstallations = [];
const sourceMethods = ['alive', 'provider', 'dispose', 'prepareNativePrewait', 'invokeNativeOperation'];
export function installNativePromptScopeForEntry(entry) {
    if (installation && !installation.stopped) throw Error('NATIVE_PROMPT_SCOPE_ALREADY_INSTALLED');
    const getRuntime = entry?.getRuntime, getBridge = entry?.getNativePrewaitBridge;
    if (typeof getRuntime !== 'function' || typeof getBridge !== 'function') throw Error('ACTUAL_NATIVE_ENTRY_REQUIRED');
    const runtime = getRuntime(), owner = runtime.ledger, page = globalThis.document;
    const element = page?.documentElement, active = element?.__deathReturnLedgerOwners?.active;
    const nativeContext = globalThis.SillyTavern?.getContext;
    if (typeof runtime.context !== 'function' || typeof runtime.isAlive !== 'function' || typeof nativeContext !== 'function'
        || !active || sourceMethods.some(k => typeof owner?.[k] !== 'function' || owner[k] !== active[k])
        || owner.alive() !== true || runtime.isAlive() !== true || getBridge().current() !== true)
        throw Error('NATIVE_PROMPT_ACTUAL_OWNER_UNPROVEN');
    const ctx = nativeContext(), own = runtime.context();
    if (!Array.isArray(ctx.chat) || !ctx.chatMetadata || ctx.chat !== own.chat || ctx.chatMetadata !== own.chatMetadata
        || !ctx.getCurrentChatId?.() || ctx.getCurrentChatId() !== own.getCurrentChatId()) throw Error('NATIVE_PROMPT_CHAT_UNPROVEN');
    const record = {getRuntime, getBridge, owner, active, nativeContext, page, element, scriptCurrent:runtime.isAlive,
        context:runtime.context, chat:ctx.chat, metadata:ctx.chatMetadata, chatId:ctx.getCurrentChatId(),
        group:ctx.groupId ?? null, character:ctx.characterId ?? null, avatar:ctx.characters?.[ctx.characterId]?.avatar ?? null};
    knownInstallations = knownInstallations.filter(pair => pair.runtime.deref() && pair.bridge.deref());
    if (!knownInstallations.some(pair => pair.runtime.deref() === getRuntime && pair.bridge.deref() === getBridge))
        knownInstallations.push({runtime:new WeakRef(getRuntime), bridge:new WeakRef(getBridge)});
    installation = record;
    return () => { record.stopped = true; };
}
function current(record) {
    if (record.stopped || installation !== record || globalThis.document !== record.page
        || record.element.__deathReturnLedgerOwners?.active !== record.active || record.scriptCurrent() !== true) return false;
    const runtime = record.getRuntime(), ctx = record.nativeContext(), own = record.context();
    return runtime.ledger === record.owner && runtime.isAlive === record.scriptCurrent && runtime.context === record.context
        && sourceMethods.every(k => record.owner[k] === record.active[k])
        && ctx.chat === record.chat && ctx.chatMetadata === record.metadata && own.chat === record.chat && own.chatMetadata === record.metadata
        && ctx.getCurrentChatId() === record.chatId && own.getCurrentChatId() === record.chatId
        && (ctx.groupId ?? null) === record.group && (ctx.characterId ?? null) === record.character
        && (ctx.characters?.[ctx.characterId]?.avatar ?? null) === record.avatar;
}
export function captureNativePromptScope(coreChat) {
    const record = installation, source = readNativePromptRequestSource(coreChat);
    const matchesCurrent = source.kind === 'authenticated' && record && source.matches(record.getRuntime, record.getBridge);
    const matchesHistory = source.kind === 'authenticated' && knownInstallations.some(pair => {
        const runtime = pair.runtime.deref(), bridge = pair.bridge.deref();
        return runtime && bridge && source.matches(runtime, bridge);
    });
    if (matchesCurrent || matchesHistory) {
        try {
            if (source.disabled()) return Object.freeze({kind:'disabled'});
            if (!matchesCurrent) return Object.freeze({kind:'applicable', failure:'native-prompt-request-installation-retired', current:() => false});
            const still = () => { try { return source.current() && current(record); } catch { return false; } };
            if (!still()) return Object.freeze({kind:'applicable', failure:'native-prompt-request-source-expired', current:() => false});
            return Object.freeze({kind:'applicable', current:still,returnOutput:source.returnOutput});
        } catch { return Object.freeze({kind:'applicable', failure:'native-prompt-request-source-error', current:() => false}); }
    }
    if (!record || record.stopped) return Object.freeze({kind:'uninstalled'});
    let ctx;
    try { ctx = globalThis.SillyTavern?.getContext?.(); } catch { return Object.freeze({kind:'unknown', code:'native-prompt-scope-context-error'}); }
    try {
        if (!ctx || typeof ctx.getCurrentChatId !== 'function') return Object.freeze({kind:'unknown', code:'native-prompt-scope-context-unavailable'});
        if (globalThis.document !== record.page || ctx.chat !== record.chat || ctx.chatMetadata !== record.metadata
            || ctx.getCurrentChatId() !== record.chatId || (ctx.groupId ?? null) !== record.group) return Object.freeze({kind:'outside'});
        if ((ctx.characterId ?? null) !== record.character || (ctx.characters?.[ctx.characterId]?.avatar ?? null) !== record.avatar) {
            if (record.group !== null) return Object.freeze({kind:'applicable', failure:'native-prompt-group-member-unproven', current:() => false});
            return Object.freeze({kind:'outside'});
        }
    } catch { return Object.freeze({kind:'unknown', code:'native-prompt-scope-target-unreadable'}); }
    try {
        if (!current(record)) return Object.freeze({kind:'applicable', failure:'native-prompt-scope-owner-unproven', current:() => false});
        return Object.freeze({kind:'applicable', current:() => { try { return current(record); } catch { return false; } }});
    } catch { return Object.freeze({kind:'applicable', failure:'native-prompt-scope-owner-error', current:() => false}); }
}
