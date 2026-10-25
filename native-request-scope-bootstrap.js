import * as helper from './native-prewait.js';
import * as prompt from './death-return-prompt/prompt-runtime.js';
const slot = Symbol.for('death-return-native-entry.ready.v1');
const event = 'death-return-native-entry-lifecycle-v1';
let extensionIntent = 'unknown', installation = null, subscription = null, cleanupPending = null;
let status = Object.freeze({ok:false, code:'NATIVE_BOOTSTRAP_ENTRY_HANDOFF_UNPROVEN'});
const result = (ok, code, details = {}) => status = Object.freeze({ok, code, ...details});
function live(record) {
    try { return record.source.current() === true && globalThis.document === record.source.page
        && record.view.getRuntime().ledger === record.owner && record.owner.alive() === true
        && record.view.getNativePrewaitBridge() === record.bridge && record.bridge.current() === true; }
    catch { return false; }
}
function stopHandles(record) {
    const errors = [];
    for (const key of ['stopScope','stopHelper']) {
        try { record[key]?.(); record[key] = null; } catch (error) { errors.push(String(error.message)); }
    }
    return errors;
}
function retireIfExpired() {
    const record = installation;
    if (!record || record.retired || live(record)) return;
    record.retired = true;
    prompt.retire();
    const cleanupErrors = stopHandles(record);
    if (cleanupErrors.length) cleanupPending = record;
    result(false, 'NATIVE_BOOTSTRAP_ENTRY_RETIRED', {cleanupErrors});
}
function installFromActualProducer() {
    retireIfExpired();
    if (cleanupPending) return result(false, 'NATIVE_BOOTSTRAP_CLEANUP_PENDING');
    const source = globalThis.document?.documentElement?.[slot];
    if (!source) return result(false, 'NATIVE_BOOTSTRAP_ENTRY_HANDOFF_UNPROVEN');
    if (installation && !installation.retired) {
        return source === installation.source ? result(true, 'NATIVE_BOOTSTRAP_ALREADY_INSTALLED')
            : result(false, 'NATIVE_BOOTSTRAP_DIFFERENT_ENTRY_PENDING');
    }
    let record;
    try {
        const view = source.view;
        if (!Object.isFrozen(source) || !Object.isFrozen(view) || Object.keys(view).join(',') !== 'getRuntime,getNativePrewaitBridge'
            || typeof view.getRuntime !== 'function' || typeof view.getNativePrewaitBridge !== 'function'
            || typeof source.current !== 'function' || source.current() !== true || source.page !== globalThis.document)
            return result(false, 'NATIVE_BOOTSTRAP_ACTUAL_READY_UNPROVEN');
        record = {source, view, owner:view.getRuntime().ledger, bridge:view.getNativePrewaitBridge(), retired:false, stopHelper:null, stopScope:null};
        // Provenance is the admitted actual-entry producer path, not this shape check.
        record.stopHelper = helper.installNativePrewaitForEntry(view, () => extensionIntent === 'disabled' ? false : true);
    } catch (error) { return result(false, 'NATIVE_BOOTSTRAP_HELPER_REFUSED', {cause:String(error.message)}); }
    try {
        record.stopScope = prompt.installNativePromptScopeForEntry(record.view);
        if (!live(record)) throw Error('NATIVE_BOOTSTRAP_READY_EXPIRED_BEFORE_PUBLICATION');
        if (globalThis.deathReturnPromptProviderV1 !== record.owner.provider)
            throw Error('NATIVE_BOOTSTRAP_OWNER_PROVIDER_UNPROVEN');
        prompt.activate(retireIfExpired);
        installation = record;
        return result(true, 'NATIVE_BOOTSTRAP_INSTALLED');
    } catch (error) {
        cleanupPending = record;
        const cleanupErrors = stopHandles(record);
        const publicationPending = error.message === 'NATIVE_BOOTSTRAP_PUBLICATION_ROLLBACK_FAILED'
            || error.message === 'NATIVE_BOOTSTRAP_PUBLICATION_CLEANUP_PENDING';
        if (!cleanupErrors.length && !publicationPending) cleanupPending = null;
        return result(false, 'NATIVE_BOOTSTRAP_INSTALLATION_REFUSED', {cause:String(error.message), cleanupErrors});
    }
}
function onEntryLifecycle() {
    if (extensionIntent === 'enabled') installFromActualProducer();
}
export function activate() {
    extensionIntent = 'enabled';
    if (cleanupPending) return result(false, 'NATIVE_BOOTSTRAP_CLEANUP_PENDING');
    if (!subscription) {
        const page = globalThis.document;
        if (!page || typeof page.addEventListener !== 'function') return result(false, 'NATIVE_BOOTSTRAP_HOST_DOCUMENT_UNPROVEN');
        page.addEventListener(event, onEntryLifecycle);
        subscription = page;
    }
    return installFromActualProducer();
}
export function disable() {
    extensionIntent = 'disabled';
    const errors = [];
    try { prompt.clean(); } catch (error) { errors.push(String(error.message)); }
    for (const record of new Set([installation, cleanupPending])) if (record) errors.push(...stopHandles(record));
    if (subscription) {
        try { subscription.removeEventListener(event, onEntryLifecycle); subscription = null; }
        catch (error) { errors.push(String(error.message)); }
    }
    if (!errors.length) { installation = null; cleanupPending = null; }
    else cleanupPending ??= installation ?? {};
    return result(!errors.length, errors.length ? 'NATIVE_BOOTSTRAP_DISABLE_CLEANUP_FAILED' : 'NATIVE_BOOTSTRAP_DISABLED', {cleanupErrors:errors});
}
export function clean() { return disable(); }
export function readBootstrapStatus() { return status; }
