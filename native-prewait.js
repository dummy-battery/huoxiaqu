let binding = null, current = null, serial = 0;
const promptOperations = new WeakMap(), promptRequests = new WeakMap();
const absentPromptSource = Object.freeze({kind:'absent'});
function invokeWithPromptSource(installed, bridge, capability, descriptor, operation, request) {
    return bridge.invokeOperation(capability, descriptor, node => {
        if (!installed.entry) return operation(node);
        const entry = installed.entry, runtime = entry.getRuntime(), scope = request.readScope();
        if(descriptor.route==='Generate'&&descriptor.type!=='continue')runtime.ledger.invalidateReturnContinue();
        const returnOutput=descriptor.route==='Generate'&&descriptor.type==='continue'?runtime.ledger.prepareReturnContinue(node):null;
        const capture = runtime.capture;
        const existing = capture?.inspect?.();
        if (existing && typeof capture.current !== 'function') throw Error('NATIVE_SOURCE_CAPTURE_CURRENT_UNAVAILABLE');
        if (existing && capture.current() !== true) {
            if (typeof capture.retireExpired !== 'function') throw Error('NATIVE_SOURCE_CAPTURE_RETIRE_UNAVAILABLE');
            const retired = capture.retireExpired();
            if (retired?.ok !== true) throw Error(retired?.code ?? 'NATIVE_SOURCE_CAPTURE_RETIRE_REFUSED');
        }
        const record = {active:true,returnOutput,bridge,descriptor,capture,initialRequestId:capture?.inspect()?.requestId ?? null,sourceRequestId:null};
        const matches = (getRuntime, getBridge) => getRuntime === entry.getRuntime && getBridge === installed.getBridge;
        const disabled = () => installed.enabled() === false;
        const currentSource = () => {
            try {
                const now = request.readScope(), rt = entry.getRuntime(), ctx = runtime.context();
                return record.active && binding === installed && installed.enabled() === true
                    && installed.ownerCurrent() === true && installed.getBridge() === bridge
                    && rt.ledger === runtime.ledger && rt.context === runtime.context && rt.isAlive === runtime.isAlive
                    && rt.isAlive() === true && runtime.ledger.alive() === true
                    && globalThis.document === scope.page && now.page === scope.page
                    && ctx.chat === scope.chat && ctx.chatMetadata === scope.metadata && ctx.getCurrentChatId() === scope.chatId
                    && now.chat === scope.chat && now.metadata === scope.metadata && now.chatId === scope.chatId
                    && (ctx.groupId ?? null) === (scope.group ?? null) && now.group === scope.group
                    && (ctx.characterId ?? null) === (scope.character ?? null)
                    && (ctx.characters?.[ctx.characterId]?.avatar ?? null) === (scope.avatar ?? null);
            } catch { return false; }
        };
        record.currentSource = currentSource;
        record.view = Object.freeze({kind:'authenticated', matches, disabled, current:currentSource,returnOutput});
        promptOperations.set(node, record);
        const finish = () => { record.active = false; promptOperations.delete(node); };
        let result;
        try { result = operation(node); } catch (error) { finish(); throw error; }
        return Promise.resolve(result).finally(finish);
    });
}
export function confirmNativeRequestSource(node, type, dryRun) {
    if (dryRun || !['normal', 'regenerate', 'continue'].includes(type)) return { ok:true, code:'NATIVE_SOURCE_NOT_APPLICABLE' };
    if (!node) return { ok:true, code:'NATIVE_SOURCE_OUTSIDE_ENTRY' };
    const record = promptOperations.get(node);
    if (!record?.active || record.currentSource() !== true || record.descriptor.route !== 'Generate' || record.descriptor.type !== type)
        return refuse('NATIVE_SOURCE_OPERATION_EXPIRED');
    if (type === 'continue' && !record.returnOutput) return { ok:true, code:'NATIVE_SOURCE_CONTINUE_NOT_APPLICABLE' };
    if (record.initialRequestId !== null || !record.capture || record.capture !== binding?.entry?.getRuntime().capture || !record.capture.current()) return refuse('NATIVE_SOURCE_CAPTURE_OWNER_EXPIRED');
    const requestId = record.capture.inspect()?.requestId;
    if (!requestId || record.sourceRequestId !== null && record.sourceRequestId !== requestId) return refuse('NATIVE_SOURCE_REQUEST_EXPIRED');
    if (typeof record.bridge.confirmSource !== 'function') return refuse('NATIVE_SOURCE_BRIDGE_UNAVAILABLE');
    const result = record.bridge.confirmSource(type, requestId);
    if (result?.ok !== true || result.requestId !== requestId) return refuse('NATIVE_SOURCE_CONFIRMATION_REFUSED', result);
    record.sourceRequestId = requestId;
    return result;
}
export function readNativeReturnContinueOutput(node) {
    const record=promptOperations.get(node);
    if(!record?.active)return null;
    // Retain an expired credential: callers must reject, never fall back to old tail.
    return record.returnOutput;
}
export function withNativePromptRequestSource(operationNode, coreChat, dispatch) {
    if (!Array.isArray(coreChat) || typeof dispatch !== 'function') throw Error('NATIVE_PROMPT_DISPATCH_ARGUMENT');
    if (promptRequests.has(coreChat)) throw Error('NATIVE_PROMPT_REQUEST_ALREADY_BOUND');
    const record = operationNode && promptOperations.get(operationNode);
    if (!record?.active) return dispatch();
    promptRequests.set(coreChat, record);
    const finish = () => { if (promptRequests.get(coreChat) === record) promptRequests.delete(coreChat); };
    let result;
    try { result = dispatch(); } catch (error) { finish(); throw error; }
    return Promise.resolve(result).finally(finish);
}
export function readNativePromptRequestSource(coreChat) {
    return promptRequests.get(coreChat)?.view ?? absentPromptSource;
}
const refuse = (code, cause) => ({ ok: false, code, ...(cause ? { cause } : {}) });
export function installNativePrewaitConsumer(getBridge, enabled, ownerCurrent) {
    if (typeof getBridge !== 'function' || typeof enabled !== 'function' || typeof ownerCurrent !== 'function') throw Error('PREWAIT_INSTALL_ARGUMENT');
    if (current || binding) throw Error('PREWAIT_ALREADY_INSTALLED_OR_IN_FLIGHT');
    const token = Object.freeze({});
    binding = { getBridge, enabled, ownerCurrent, token };
    return () => { if (binding?.token === token) binding = null; };
}
export function installNativePrewaitForEntry(entry, enabled) {
    const owner = entry.getRuntime().ledger, getter = entry.getNativePrewaitBridge;
    if (!owner || typeof owner.alive !== 'function' || typeof getter !== 'function') throw Error('PREWAIT_ACTUAL_ENTRY_REQUIRED');
    const facade = getter();
    if (facade.ownerLease !== owner.leaseId || facade.operationVersion !== 1 || typeof facade.current !== 'function') throw Error('PREWAIT_OPERATION_SOURCE_UNAVAILABLE');
    const context = entry.getRuntime().context();
    const target = Object.freeze({page:globalThis.document, group:context.groupId ?? null,
        character:context.characterId ?? null, avatar:context.characters?.[context.characterId]?.avatar ?? null});
    const stop = installNativePrewaitConsumer(getter, enabled, () => owner.alive() && getter() === facade && facade.current());
    binding.entry = entry;
    binding.owner = owner;
    binding.target = target;
    return stop;
}
function outsideEntryCard(installed, request) {
    try {
        const target = installed.target, scope = request.readScope(), ctx = globalThis.SillyTavern?.getContext?.();
        if (!target || target.group !== null || scope.group !== (ctx.groupId ?? null)
            || target.character === null || typeof target.avatar !== 'string' || !target.avatar
            || target.page !== globalThis.document || scope.page !== target.page
            || scope.chat !== ctx.chat || scope.metadata !== ctx.chatMetadata || scope.chatId !== ctx.getCurrentChatId()) return false;
        if (scope.group === null) {
            if (scope.character == null || typeof scope.avatar !== 'string' || !scope.avatar
                || scope.character !== ctx.characterId || scope.avatar !== ctx.characters?.[ctx.characterId]?.avatar
                || scope.character === target.character || scope.avatar === target.avatar) return false;
        } else if (typeof scope.group !== 'string' || !scope.group.length) return false;
        const active = target.page.documentElement?.__deathReturnLedgerOwners?.active;
        if (active && active !== installed.owner && active.alive() === true) return false;
        return true;
    } catch { return false; }
}
export function runNativePrewait(request, operation, parent = null) {
    const installed = binding;
    if (!installed) return parent ? refuse('PREWAIT_BINDING_RETIRED') : operation(null);
    const enabled = installed.enabled();
    if (enabled === false) return parent ? refuse('PREWAIT_OPERATION_DISABLED') : operation(null);
    if (enabled !== true) return refuse('PREWAIT_ENABLED_UNPROVEN');
    if (request.dryRun && !parent) return operation(null);
    if (!parent && outsideEntryCard(installed, request)) return operation(null);
    if (installed.ownerCurrent() !== true) return refuse('PREWAIT_OWNER_RETIRED');
    const bridge = installed.getBridge();
    if (!bridge || bridge.version !== 1 || bridge.operationVersion !== 1 || !Object.isFrozen(bridge)
        || !['prepare', 'wait', 'consume', 'cancel', 'invokeOperation'].every(k => typeof bridge[k] === 'function'))
        return refuse('PREWAIT_OPERATION_BRIDGE_UNAVAILABLE');
    const descriptor = { route: request.route, type: request.type, automatic: request.automatic === true, byAutoMode: request.byAutoMode === true };
    if (parent) return invokeWithPromptSource(installed, bridge, parent, descriptor, operation, request);
    if (current) return refuse('PREWAIT_OPERATION_ALREADY_PENDING');
    const input = request.readInput();
    if (['send', 'Generate'].includes(request.route) && input.trim().startsWith('/'))
        return refuse('PREWAIT_TYPED_SLASH_CAPABILITY_UNIMPLEMENTED');
    const scope = request.readScope(), record = { phase: 'waiting' };
    current = record;
    return (async () => {
        let prepared;
        try {
            prepared = bridge.prepare({ requestId: 'native-prewait:' + (++serial), type: request.type,
                input, targetIndex: scope.targetIndex, readInput: request.readInput,
                signal: request.signal, timeoutMs: 120000,
                operation: { route: descriptor.route, automatic: descriptor.automatic, byAutoMode: descriptor.byAutoMode, readScope: request.readScope } });
            if (prepared?.ok !== true) return refuse('PREWAIT_PREPARE_REFUSED', prepared);
            const confirmed = await bridge.wait(prepared.ticket);
            if (confirmed?.ok !== true) return refuse('PREWAIT_CONFIRMATION_REFUSED', confirmed);
            if (binding !== installed || installed.enabled() !== true || installed.ownerCurrent() !== true || installed.getBridge() !== bridge) {
                bridge.cancel(prepared.ticket);
                return refuse('PREWAIT_BINDING_OR_OWNER_EXPIRED');
            }
            const released = bridge.consume(prepared.ticket);
            if (released?.ok !== true) return refuse('PREWAIT_CONSUME_REFUSED', released);
            record.phase = 'running';
            return await invokeWithPromptSource(installed, bridge, released.operation, descriptor, operation, request);
        } catch (error) {
            if (record.phase === 'running') throw error;
            if (prepared?.ticket) bridge.cancel(prepared.ticket);
            return refuse('PREWAIT_OPERATION_EXCEPTION', { message: String(error.message) });
        } finally {
            record.phase = 'ended';
            if (current === record) current = null;
        }
    })();
}
export function selectNativePrewaitMember(node, member, select) {
    if (!node) return select();
    if (!binding || binding.enabled() !== true || binding.ownerCurrent() !== true) return refuse('PREWAIT_MEMBER_OWNER_EXPIRED');
    return binding.getBridge().selectMember(node, member, select);
}
export function cleanupNativePrewaitMember(node, select) {
    if (!node) return select();
    if (!binding) return refuse('PREWAIT_CLEANUP_BINDING_RETIRED');
    return binding.getBridge().cleanupMember(node, select);
}
