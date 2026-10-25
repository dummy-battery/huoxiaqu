// 单一映射：原生楼层 -> 重排位置；IN_CHAT 深度换算；可插拔世界书 @D 定位桥。
const IDENTITY = 'deathReturnPrompt';
const interceptedRequests = new WeakMap();
let requestEpoch = 0;
const nativeDepths = new WeakMap();
const registryChanges = [];
const suppressedEntries = new WeakSet();
export function isRegisteredInChatPromptSuppressed(entry) { return Boolean(entry) && suppressedEntries.has(entry); }
let currentMap = null, capability = null, lastCode = 'reorder-map-none';
const isInt = v => Number.isInteger(v) && v >= 0;
const identityOf = row => { const value = row?.extra?.[IDENTITY]?.uid; return typeof value === 'string' && value.length > 0 ? value : null; };
const note = code => { lastCode = String(code); };

export function buildReorderMap({ nativeRows, rows, ownership } = {}) {
    if (!Array.isArray(nativeRows) || !Array.isArray(rows) || !Array.isArray(ownership)) return { ok: false, code: 'REORDER-MAP-ARGUMENT' };
    const nativeIndexToProjected = new Map(), identityToProjected = new Map(), projectedToIdentity = new Map();
    for (const owned of ownership) {
        if (!owned || !isInt(owned.sourceIndex) || owned.sourceIndex >= nativeRows.length) return { ok: false, code: 'REORDER-MAP-SOURCE-INDEX' };
        const projected = rows.indexOf(owned.row);
        if (projected < 0) return { ok: false, code: 'REORDER-MAP-PROJECTED-ROW-MISSING' };
        if (nativeIndexToProjected.has(owned.sourceIndex)) return { ok: false, code: 'REORDER-MAP-AMBIGUOUS-SOURCE' };
        nativeIndexToProjected.set(owned.sourceIndex, projected);
    }
    for (const [index, row] of rows.entries()) {
        const identity = identityOf(row);
        if (identity === null) continue;
        if (identityToProjected.has(identity)) return { ok: false, code: 'REORDER-MAP-AMBIGUOUS-IDENTITY' };
        identityToProjected.set(identity, index);
        projectedToIdentity.set(index, identity);
    }
    return { ok: true, code: 'REORDER-MAP-BUILT', nativeLength: nativeRows.length, projectedLength: rows.length, nativeIndexToProjected, identityToProjected, projectedToIdentity };
}
export function publishReorderMap(candidate) {
    if (!candidate?.ok) { currentMap = null; note(candidate?.code ?? 'REORDER-MAP-NOT-PUBLISHED'); return false; }
    currentMap = candidate; note('reorder-map-active'); return true;
}
export function publishProjectionMap({ nativeRows, rows, ownership } = {}) { return publishReorderMap(buildReorderMap({ nativeRows, rows, ownership })); }
export function clearReorderMap(code = 'reorder-map-cleared') { currentMap = null; resolvedInChatDepth = null; note(code); }
export function beginRequestEpoch() { requestEpoch += 1; return requestEpoch; }
export function endRequestEpoch() { requestEpoch += 1; return requestEpoch; }
export function reorderMapStatus() {
    return Object.freeze({ active: currentMap !== null, nativeLength: currentMap?.nativeLength ?? null, projectedLength: currentMap?.projectedLength ?? null,
        mappedNativeRows: currentMap?.nativeIndexToProjected?.size ?? 0, mappedIdentities: currentMap?.identityToProjected?.size ?? 0,
        worldInfoBridge: capability ? 'installed' : 'absent', lastCode });
}
// @D 站点按身份解析出的深度：由漏斗单次消费，避免同一次注册被二次换算。
let resolvedInChatDepth = null;
export function resolveNextInChatDepth(depth) { const value = Number(depth); resolvedInChatDepth = Number.isInteger(value) && value >= 0 ? value : null; }
export function takeResolvedInChatDepth() { const value = resolvedInChatDepth; resolvedInChatDepth = null; return value; }
export function reorderProjectedIndex(identity) { return currentMap ? (currentMap.identityToProjected.get(identity) ?? null) : null; }
export function nativeMessageUidToReorderedIndex(uid) { return reorderProjectedIndex(uid); }
export function reorderedIndexToNativeMessageUid(index) { return currentMap ? (currentMap.projectedToIdentity.get(Number(index)) ?? null) : null; }
export function reorderExpectedDepth(identity) { const index = reorderProjectedIndex(identity); return index === null || !currentMap ? null : currentMap.projectedLength - 1 - index; }
export function markRequestIntercepted(coreChat) { if (coreChat && (typeof coreChat === 'object' || typeof coreChat === 'function')) interceptedRequests.set(coreChat, requestEpoch); }
export function wasRequestIntercepted(coreChat) { return Boolean(coreChat) && (typeof coreChat === 'object' || typeof coreChat === 'function') && interceptedRequests.get(coreChat) === requestEpoch; }
// 尾锚换算：原生深度 d -> 原生下标 len-1-d -> 该消息在重排数组中的下标 -> 距新数组末端的条数。
function tailAnchor(map, depth) {
    if (!isInt(depth)) return { state: 'skip', code: 'INVALID-DEPTH' };
    const anchor = map.nativeLength - 1 - depth;
    if (anchor < 0) return { state: 'skip', code: 'DEPTH-BEYOND-NATIVE-LENGTH' };
    const projected = map.nativeIndexToProjected.get(anchor);
    if (projected === undefined) return { state: 'skip', code: 'ANCHOR-NOT-MAPPED' };
    return { state: 'ok', depth: map.projectedLength - 1 - projected, anchorNative: anchor, projected };
}
export function mapInChatPromptDepth(inChat, depth, key = null) {
    const native = Number(depth);
    if (!inChat) return { state: 'ok', depth: native, code: 'NOT-IN-CHAT' };
    if (!currentMap) return { state: 'ok', depth: native, code: 'NO-REORDER-MAP' };
    const mapped = tailAnchor(currentMap, native);
    if (mapped.state !== 'ok') { note(mapped.code); return { state: 'skip', code: mapped.code }; }
    return { state: 'ok', depth: mapped.depth, code: mapped.depth === native ? 'IN-PLACE' : 'REORDERED', anchorNative: mapped.anchorNative, projected: mapped.projected };
}
export function recordRegisteredInChatPrompt(entry, nativeDepth, alreadyResolved = false, registry = null, key = null) {
    if (!entry || typeof entry !== 'object') return;
    const source = { depth: Number(nativeDepth), lastDepth: Number(entry.depth), alreadyResolved };
    nativeDepths.set(entry, source);
    if (alreadyResolved && registry && key !== null) registryChanges.push({ registry, key, entry, resolved: true });
    if (!alreadyResolved && registry && key !== null && source.depth !== Number(entry.depth)) {
        registryChanges.push({ registry, key, entry, original: source.depth, mapped: Number(entry.depth) });
    }
}
export function suppressRegisteredInChatPrompt(registry, key) {
    if (!currentMap || !registry || !Object.prototype.hasOwnProperty.call(registry, key)) return;
    const entry = registry[key];
    if (!entry || typeof entry !== 'object' || suppressedEntries.has(entry)) return;
    suppressedEntries.add(entry);
    registryChanges.push({ registry, key, entry, suppressed: true });
}
export function restoreRegisteredInChatPrompts() {
    for (let i = registryChanges.length - 1; i >= 0; i--) {
        const change = registryChanges[i];
        if (change.suppressed) {
            suppressedEntries.delete(change.entry);
        } else if (change.resolved) {
            if (change.registry[change.key] === change.entry) delete change.registry[change.key];
        } else if (change.removed) {
            if (!Object.prototype.hasOwnProperty.call(change.registry, change.key)) change.registry[change.key] = change.entry;
        } else if (change.registry[change.key] === change.entry && change.entry.depth === change.mapped) {
            change.entry.depth = change.original;
            const source = nativeDepths.get(change.entry);
            if (source) source.lastDepth = change.original;
        }
    }
    registryChanges.length = 0;
}
export function sweepRegisteredInChatPrompts(registry, isInChat) {
    if (!registry || typeof isInChat !== 'function' || !currentMap) return { swept: 0, skipped: 0 };
    let swept = 0, skipped = 0;
    for (const [key, entry] of Object.entries(registry)) {
        if (!entry || !isInChat(entry.position)) continue;
        let source = nativeDepths.get(entry);
        if (!source || source.lastDepth !== Number(entry.depth)) { source = { depth: Number(entry.depth), lastDepth: Number(entry.depth), alreadyResolved: false }; nativeDepths.set(entry, source); }
        if (source.alreadyResolved) continue;
        const mapped = tailAnchor(currentMap, source.depth);
        if (mapped.state !== 'ok') {
            suppressRegisteredInChatPrompt(registry, key);
            skipped++; note(mapped.code); continue;
        }
        if (mapped.depth !== Number(entry.depth)) {
            registryChanges.push({ registry, key, entry, original: Number(entry.depth), mapped: mapped.depth });
            entry.depth = mapped.depth; source.lastDepth = mapped.depth; swept++;
        }
    }
    return { swept, skipped };
}
export function inChatConsumerMaxDepth(nativeMax, prompts, removedTail = 0) {
    if (!currentMap) return nativeMax;
    return Math.max(0, nativeMax - inChatConsumerRemovedTail(removedTail), ...prompts.map(prompt => prompt.injection_depth ?? 0));
}
export function inChatConsumerRemovedTail(removedTail = 0) {
    return currentMap && isInt(removedTail) ? removedTail : 0;
}
export function inChatConsumerSourceDepths(depth, removedTail = 0) {
    const offset = inChatConsumerRemovedTail(removedTail);
    return depth === 0 ? Array.from({ length: offset + 1 }, (_, i) => i) : [depth + offset];
}
export function mapAbsoluteInChatPrompts(prompts, removedTail = 0) {
    return prompts.flatMap(prompt => {
        const mapped = mapInChatPromptDepth(true, prompt.injection_depth);
        return mapped.state === 'ok' ? [{ ...prompt, injection_depth: Math.max(0, mapped.depth - inChatConsumerRemovedTail(removedTail)) }] : [];
    });
}
export function installWorldInfoDepthBridge(candidate) {
    if (candidate === null || candidate === undefined) { capability = null; note('WORLD_INFO_DEPTH_BRIDGE_RETIRED'); return { ok: true, code: 'WORLD_INFO_DEPTH_BRIDGE_RETIRED' }; }
    if (candidate.version !== 1 || typeof candidate.locate !== 'function') { capability = null; note('WORLD_INFO_DEPTH_BRIDGE_REJECTED'); return { ok: false, code: 'WORLD_INFO_DEPTH_BRIDGE_REJECTED' }; }
    capability = candidate; note('WORLD_INFO_DEPTH_BRIDGE_INSTALLED'); return { ok: true, code: 'WORLD_INFO_DEPTH_BRIDGE_INSTALLED' };
}
export function worldInfoDepthBridgeStatus() {
    return Object.freeze({ installed: capability !== null, version: capability?.version ?? null, code: capability ? 'WORLD_INFO_DEPTH_BRIDGE_INSTALLED' : 'WORLD_INFO_DEPTH_BRIDGE_UNIMPLEMENTED' });
}
// 世界书 @D：无投影时原样；有投影而宿主无定位能力/定位不到 -> UNIMPLEMENTED/fail-closed（绝不按猜测深度注入）。
export function mapWorldInfoDepthEntry(entry) {
    const depth = Number(entry?.depth);
    if (!currentMap) return { state: 'ok', depth, code: 'NO-REORDER-MAP' };
    if (!capability) { note('WORLD_INFO_DEPTH_BRIDGE_UNIMPLEMENTED'); return { state: 'unimplemented', code: 'WORLD_INFO_DEPTH_BRIDGE_UNIMPLEMENTED' }; }
    let located = null;
    try { located = capability.locate(entry); } catch { note('WORLD_INFO_DEPTH_BRIDGE_ERROR'); return { state: 'unimplemented', code: 'WORLD_INFO_DEPTH_BRIDGE_ERROR' }; }
    const identity = typeof located?.identity === 'string' && located.identity.length > 0 ? located.identity : null;
    if (identity === null) { note('WORLD_INFO_DEPTH_IDENTITY_UNPROVEN'); return { state: 'unimplemented', code: 'WORLD_INFO_DEPTH_IDENTITY_UNPROVEN' }; }
    const projected = currentMap.identityToProjected.get(identity);
    if (projected === undefined) { note('WORLD_INFO_DEPTH_IDENTITY_NOT-MAPPED'); return { state: 'unmapped', code: 'WORLD_INFO_DEPTH_IDENTITY_NOT-MAPPED', identity }; }
    return { state: 'ok', depth: currentMap.projectedLength - 1 - projected, identity, projected, code: 'IDENTITY-MAPPED' };
}
