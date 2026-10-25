import { captureNativePromptScope } from './native-prompt-scope.js';
import { readNativePromptRequestSource } from '../native-prewait.js';
export { installNativePromptScopeForEntry } from './native-prompt-scope.js';
import { describeRequest } from './algorithm.js';
import { projectRequest } from './three-layer.js';
import { markRequestIntercepted, clearReorderMap, publishProjectionMap } from './depth-bridge.js';

const functionKey = 'deathReturnPromptInterceptorV1';
const statusKey = 'deathReturnPromptStatusV1';
const ownerKey = Symbol.for('death-return-prompt-order.owner');
let enabled = false;
let retired = false, checkLifecycle = null, publication = null;
const applied = new WeakMap();
const processedRequests = new WeakMap();
let requestEpoch = 0;
const owner = {};

export function beginRequestEpoch() { requestEpoch += 1; return requestEpoch; }
export function endRequestEpoch() { requestEpoch += 1; return requestEpoch; }

function setStatus(available, code) {
    if (globalThis[ownerKey] !== owner) return;
    if (publication && globalThis[statusKey] !== publication.installed.get(statusKey)) return;
    const value = Object.freeze({ available, code, version: '0.1.0' });
    globalThis[statusKey] = value;
    publication?.installed.set(statusKey, value);
    if (!available) console.warn('[Death Return Prompt Order]', code);
}

export async function deathReturnPromptInterceptorV1(coreChat, contextSize, abort, type) {
    if (!enabled || globalThis[ownerKey] !== owner) return;
    if (!coreChat || (typeof coreChat !== 'object' && typeof coreChat !== 'function')) return;
    if (processedRequests.get(coreChat) === requestEpoch) return;
    processedRequests.set(coreChat, requestEpoch);
    markRequestIntercepted(coreChat);
    clearReorderMap('interceptor-start');
    checkLifecycle?.();
    if (retired && readNativePromptRequestSource(coreChat).kind !== 'authenticated') return;
    const scope = captureNativePromptScope(coreChat);
    if (scope.kind !== 'applicable') {
        setStatus(false, scope.code ?? 'native-prompt-scope-' + scope.kind);
        return;
    }
    const narrative = ['normal', 'regenerate', 'continue', 'swipe', 'auto'].includes(type);
    const reject = code => { setStatus(false, code); if (narrative) abort(true); };
    try {
    if (scope.failure) { reject(scope.failure); return; }
    const previous = applied.get(coreChat);
    if (previous) {
        const surviving = new Map();
        const newRows = [];
        for (const row of coreChat) {
            const owned = previous.owned.get(row);
            if (owned) {
                let mes = previous.nativeRows[owned.sourceIndex].mes;
                if (row.mes !== owned.renderedMes) {
                    mes = row.mes.startsWith(owned.prefix) && row.mes.endsWith(owned.suffix)
                        ? row.mes.slice(owned.prefix.length, row.mes.length - owned.suffix.length) : row.mes;
                }
                surviving.set(owned.sourceIndex, { ...row, mes });
            } else if (!previous.generated.has(row)) newRows.push(row);
        }
        if (surviving.size || coreChat.some(row => previous.generated.has(row))) {
            coreChat.splice(0, coreChat.length, ...[...surviving.entries()].sort((a,b) => a[0]-b[0]).map(x => x[1]), ...newRows);
        }
        applied.delete(coreChat);
    }
    if (type !== 'normal' && type !== 'regenerate' && type !== 'continue') {
        reject('unsupported-generation-type');
        return;
    }
    const provider = globalThis.deathReturnPromptProviderV1;
    let context;
    let chatId;
    try {
        context = globalThis.SillyTavern?.getContext?.();
        chatId = context?.getCurrentChatId?.();
    } catch {
        reject('host-context-error');
        return;
    }
    if (typeof provider !== 'function' || typeof context?.getCurrentChatId !== 'function') {
        reject('provider-unavailable');
        return;
    }
    const request = describeRequest(coreChat);
    const before = JSON.stringify(request);
    let proof;
    try {
        proof = provider(Object.freeze({ schemaVersion: 1, chatId, type, contextSize,
            request: Object.freeze(request.map(row => Object.freeze(row))) }));
        if (proof?.then) {
            Promise.resolve(proof).catch(() => {});
            reject('provider-must-be-synchronous');
            return;
        }
        proof = structuredClone(proof);
    } catch {
        reject('provider-error');
        return;
    }
    let currentChatId;
    try {
        currentChatId = context.getCurrentChatId();
    } catch {
        reject('host-context-error');
        return;
    }
    if (!enabled || globalThis[ownerKey] !== owner || !scope.current() || globalThis.deathReturnPromptProviderV1 !== provider
        || currentChatId !== chatId
        || before !== JSON.stringify(describeRequest(coreChat))) {
        reject('provider-ownership-or-request-changed');
        return;
    }
    if (proof?.available !== true) {
        const reason = typeof proof?.reason === 'string' && proof.reason.length ? proof.reason : proof?.code;
        reject(typeof reason === 'string' && reason.length ? reason : 'provider-unavailable');
        return;
    }
    if (proof.chatId !== chatId) { reject('provider-ownership-or-request-changed'); return; }
    if (type === 'continue' && proof.narrativeTarget && scope.returnOutput) {
        const output=scope.returnOutput;
        try{output.check();}catch{reject('pending-continue-output-expired');return;}
        const event=proof.records.find(r=>(r.eventId??r.uid)===proof.narrativeTarget.eventId);
        if(output.ownerLease!==proof.leaseId||output.returnUid!==(event?.uid??event?.eventId)||context.chat.at(-1)?.extra?.deathReturnPrompt?.uid!==output.restoreSourceUid){
            reject('pending-continue-output-certificate-mismatch');return;
        }
    }
    if (type === 'continue' && proof.narrativeTarget && !scope.returnOutput) {
        const physical = context.chat?.at(-1);
        const actual = physical ? describeRequest([physical])[0] : null;
        const requested = request.at(-1);
        if (!actual || actual.isSystem || actual.isUser || actual.ignored || !requested
            || actual.uid !== requested.uid || actual.revision !== requested.revision
            || actual.swipeId !== requested.swipeId) {
            reject('pending-continue-native-physical-target-mismatch');
            return;
        }
    }
    const result = projectRequest(coreChat, proof, type,scope.returnOutput);
    if (!result.available) {
        reject(result.code);
        return;
    }
    const nativeRows = coreChat.map(row => ({ ...row }));
    const owned = new Map(result.ownership.map(value => [value.row, { ...value, renderedMes: value.row.mes }]));
    const generated = new Set(result.rows.filter(row => !owned.has(row)));
    coreChat.splice(0, coreChat.length, ...result.rows);
    publishProjectionMap({ nativeRows, rows: result.rows, ownership: result.ownership });
    applied.set(coreChat, { nativeRows, owned, generated });
    setStatus(true, 'request-projected');
    } catch { reject('native-prompt-interceptor-error'); }
}

export function activate(lifecycle = null) {
    const previous = globalThis[ownerKey];
    if (previous && previous !== owner) throw Error('NATIVE_BOOTSTRAP_FOREIGN_PROMPT_OWNER');
    if (publication) {
        if (!publication.ready) throw Error('NATIVE_BOOTSTRAP_PUBLICATION_CLEANUP_PENDING');
        checkLifecycle = lifecycle; retired = false; enabled = true;
        return;
    }
    if (globalThis[functionKey] !== undefined) throw Error('NATIVE_BOOTSTRAP_FOREIGN_PROMPT_FUNCTION');
    const keys = [ownerKey, functionKey, statusKey];
    const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const installed = new Map();
    publication = {prior, installed, listener:false, ready:false};
    const write = (key, value) => {
        const descriptor = prior.get(key);
        if (descriptor && (!descriptor.configurable || !('value' in descriptor))) throw Error('NATIVE_BOOTSTRAP_PUBLICATION_SLOT_UNAVAILABLE');
        Object.defineProperty(globalThis, key, {value, writable:true, configurable:true, enumerable:descriptor?.enumerable ?? true});
        installed.set(key, value);
    };
    try {
        owner.dispose = clean;
        write(ownerKey, owner);
        write(functionKey, deathReturnPromptInterceptorV1);
        write(statusKey, Object.freeze({available:false, code:'provider-not-checked', version:'0.1.0'}));
        checkLifecycle = lifecycle; retired = false; enabled = true;
        publication.listener = true;
        globalThis.addEventListener?.('pagehide', onPageHide);
        publication.ready = true;
    } catch (error) {
        const cleanupErrors = releasePublication();
        if (cleanupErrors.length) throw Object.assign(Error('NATIVE_BOOTSTRAP_PUBLICATION_ROLLBACK_FAILED'), {cause:error, cleanupErrors});
        throw error;
    }
}

export function retire() { retired = true; }

function releasePublication() {
    const record = publication, errors = [];
    enabled = false; retired = false; checkLifecycle = null;
    if (!record) return errors;
    record.ready = false;
    const attempt = fn => { try { fn(); } catch (error) { errors.push(String(error.message)); } };
    if (record.listener) attempt(() => { globalThis.removeEventListener?.('pagehide', onPageHide); record.listener = false; });
    for (const [key, value] of [...record.installed].reverse()) attempt(() => {
        if (globalThis[key] === value) {
            const previous = record.prior.get(key);
            if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key];
        }
        record.installed.delete(key);
    });
    if (!errors.length) publication = null;
    return errors;
}

function onPageHide(event) {
    if (!event.persisted) clean();
}

export function clean() {
    const errors = releasePublication();
    if (errors.length) throw Object.assign(Error('NATIVE_BOOTSTRAP_PUBLICATION_CLEANUP_FAILED'), {cleanupErrors:errors});
}
