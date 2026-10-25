import { validGameTime, describeRequest } from './algorithm.js';
const id = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x);
const must = (ok, code) => { if (!ok) throw Error(code); };
const keyOf = r => r.uid ?? r.anchorId ?? r.eventId;
const boundary = new Set(['checkpoint', 'death', 'return']);
const promptOnly = (nodeId, mes, kind) => ({ name: 'Narrator', is_user: false, is_system: false, mes,
    extra: { type: 'narrator', deathReturnRequest: { nodeId, kind } } });

function snapshotProof(archive, record, records, proof) {
    const c = archive.anchor;
    const source = records.get(c.sourceMessageUid);
    must(c.type === 'exact-snapshot' && c.anchorId === record.anchorId && c.exact === true
        && c.committed === true && id(c.captureId) && c.ledgerRevision === proof.ledgerRevision
        && source?.uid && source.revision === c.sourceRevision && source.swipeId === c.sourceSwipeId,
    'unproven-snapshot-source');
    must(c.gameTime === record.gameTime && c.timelineId === record.timelineId
        && validGameTime(c.spanStartTime) && validGameTime(c.spanEndTime)
        && c.spanStartTime <= c.gameTime && c.gameTime <= c.spanEndTime
        && typeof c.snapshotMes === 'string' && c.snapshotMes.length > 0
        && c.snapshotMes === record.sourceMes && c.frontierBeforeId === record.parentId,
    'snapshot-capture-mismatch');
    must(c.sourceSpan === 'mixed' || c.sourceSpan === 'whole', 'invalid-snapshot-span');
    if (c.sourceSpan === 'mixed') must(source.position > record.position
        && (source.kind === 'ordinary' || (source.kind === 'death' && source.visibility === 'visible'
            && !source.isUser && source.timelineId === record.timelineId
            && archive.createdAfterId === source.nodeId && c.gameTime < source.gameTime))
        && c.spanEndTime === source.gameTime, 'mixed-source-crosses-snapshot-frontier');
    else must(source.position < record.position && c.spanEndTime === c.gameTime,
        'whole-source-crosses-snapshot-frontier');
}

export function projectRequest(coreChat, proof, type, returnOutput = null) {
    try {
        must(type === 'normal' || type === 'regenerate' || type === 'continue', 'unsupported-generation-type');
        must(proof?.available === true, 'provider-unavailable');
        must(proof.schemaVersion === 1 && typeof proof.chatId === 'string' && proof.chatId.length > 0
            && id(proof.leaseId) && Number.isSafeInteger(proof.ledgerRevision) && proof.ledgerRevision >= 0,
        'invalid-provider-header');
        must(Array.isArray(proof.records) && Array.isArray(proof.archives) && Array.isArray(proof.request), 'invalid-provider-shape');
        const request = describeRequest(coreChat);
        must(JSON.stringify(request) === JSON.stringify(proof.request), 'request-certificate-mismatch');
        const records = new Map();
        const events = new Set();
        for (const [position, raw] of proof.records.entries()) {
            const nodeId = keyOf(raw);
            must(id(nodeId) && !records.has(nodeId), 'ambiguous-ledger-identity');
            must(validGameTime(raw.gameTime), 'missing-or-invalid-game-time');
            must(Number.isSafeInteger(raw.timelineId) && raw.timelineId >= 0, 'missing-or-invalid-timeline-id');
            must(['ordinary', 'checkpoint', 'death', 'return', 'input'].includes(raw.kind) && id(raw.revision)
                && (raw.swipeId === null || (Number.isSafeInteger(raw.swipeId) && raw.swipeId >= 0))
                && typeof raw.isUser === 'boolean'
                && ['visible', 'system-filtered', 'ignored', 'request-only', 'virtual'].includes(raw.visibility), 'invalid-record');
            const virtual = raw.visibility === 'request-only';
            const mechanical = raw.visibility === 'virtual';
            const sourceOnly = raw.promptDisposition === 'mechanical-source';
            must(raw.promptDisposition === undefined || (sourceOnly && raw.kind === 'checkpoint'
                && raw.visibility === 'system-filtered' && !raw.isUser && id(raw.uid)
                && raw.sourceMes === undefined && raw.restore === undefined), 'invalid-mechanical-source');
            must(mechanical ? raw.kind === 'return' && id(raw.uid) && !raw.isUser
                && !raw.anchorId && raw.sourceMes === undefined && raw.messageUid == null
                : virtual ? !raw.uid && !raw.isUser
                && ((raw.kind === 'return' && id(raw.eventId) && !raw.anchorId && raw.sourceMes === undefined)
                    || (raw.kind === 'checkpoint' && id(raw.anchorId) && typeof raw.sourceMes === 'string'))
                : id(raw.uid) && !raw.anchorId && (sourceOnly || typeof raw.sourceMes === 'string'), 'invalid-record-identity');
            const eventId = raw.eventId ?? (mechanical ? raw.uid : undefined);
            if (raw.kind === 'return') {
                must(id(eventId) && !events.has(eventId), 'ambiguous-return-event'); events.add(eventId);
            }
            records.set(nodeId, { ...raw, eventId, nodeId, position,
                parentId: Object.hasOwn(raw, 'parentId') ? raw.parentId : raw.parentUid });
        }
        const archives = new Map();
        for (const raw of proof.archives) {
            const a = { ...raw, frontierId: raw.frontierId ?? raw.frontierUid,
                createdAfterId: raw.createdAfterId ?? raw.createdAfterUid };
            must(id(a.archiveId) && !archives.has(a.archiveId), 'ambiguous-archive-id');
            must(a.committed === true && records.has(a.createdAfterId) && records.has(a.frontierId), 'unproven-archive');
            const captured = records.get(a.frontierId);
            must(captured.kind === 'checkpoint' && typeof a.anchor?.location === 'string' && a.anchor.location.trim(),
                'archive-anchor-not-exact');
            if (a.anchor.type === 'whole-message') must(a.anchor.span === 'whole' && captured.uid
                && a.anchor.messageUid === captured.uid && a.anchor.revision === captured.revision, 'archive-anchor-not-exact');
            else { must(captured.visibility === 'request-only', 'snapshot-needs-request-only-node'); snapshotProof(a, captured, records, proof); }
            must(captured.position <= records.get(a.createdAfterId).position, 'future-archive-frontier');
            archives.set(a.archiveId, a);
        }
        const pathFor = nodeId => {
            const result = [], seen = new Set();
            while (nodeId !== null) {
                const r = records.get(nodeId);
                must(r && !seen.has(nodeId), 'missing-or-cyclic-parent');
                seen.add(nodeId); result.push(nodeId); nodeId = r.parentId;
            }
            return result.reverse();
        };
        let frontier = null;
        for (const r of records.values()) {
            if (r.kind === 'return') {
                const a = archives.get(r.targetArchiveId), death = records.get(r.deathUid);
                must(r.committed === true && a && death?.kind === 'death' && death.nodeId === frontier
                    && records.get(a.createdAfterId).position < r.position, 'unproven-return-boundary');
                must(r.parentId === a.frontierId && records.get(a.frontierId).position < r.position, 'return-frontier-mismatch');
            } else must(r.parentId === frontier, 'causal-parent-mismatch');
            frontier = r.nodeId;
        }
        for (const a of archives.values()) must(pathFor(a.createdAfterId).includes(a.frontierId), 'archive-capture-off-active-path');
        must((proof.frontierId ?? proof.frontierUid) === frontier, 'stale-ledger-frontier');
        const path = frontier === null ? [] : pathFor(frontier), active = new Set(path);
        must([...records.values()].filter(r => r.kind !== 'input').at(-1)?.kind !== 'death', 'pending-death-recovery');
        const selected = new Map();
        for (const [index, row] of request.entries()) {
            must(id(row.uid) && !selected.has(row.uid), 'missing-or-ambiguous-message-uid');
            const r = records.get(row.uid);
            must(r?.visibility === 'visible' && !row.ignored && !row.isSystem, 'request-visibility-mismatch');
            must(row.revision === r.revision && row.swipeId === r.swipeId && row.isUser === r.isUser, 'changed-message-version');
            must(!row.narrator || !row.isUser, 'ambiguous-narrator-role');
            selected.set(r.nodeId, { record: r, index });
        }
        const positions = [...selected.values()].map(x => x.record.position);
        must(positions.every((p, i) => i === 0 || p > positions[i - 1]), 'request-order-not-native');
        for (const r of records.values()) {
            if (r.visibility === 'ignored') { must(r.kind === 'ordinary', 'intentionally-hidden-boundary'); continue; }
            if (r.visibility === 'system-filtered' && boundary.has(r.kind)) {
                // Owner-certified genesis checkpoint: identity/state source only, never a body.
                if (r.promptDisposition === 'mechanical-source') continue;
                must(r.restore?.reason === 'native-system-filter' && r.restore.revision === r.revision && !r.isUser,
                    'unproven-system-restoration');
                if (r.position >= positions[0] && r.position <= positions.at(-1)) {
                    selected.set(r.nodeId, { record: r, index: null });
                }
            }
            if (r.visibility === 'request-only' && r.kind === 'checkpoint') {
                must([...archives.values()].some(a => a.frontierId === r.nodeId), 'unclaimed-snapshot-node');
                selected.set(r.nodeId, { record: r, index: null });
            }
        }
        const units = [...selected.values()].sort((a, b) => a.record.position - b.record.position);
        const input = selected.get(proof.inputUid);
        if (proof.inputUid !== null) must(input?.record.kind === 'input' && input.record.isUser
            && input.index === request.length - 1 && input.record.nodeId === frontier, 'latest-user-not-pinned');
        else must(!units.some(x => x.record.kind === 'input'), 'unclaimed-input');
        const old = units.filter(x => x !== input && (!active.has(x.record.nodeId) || x.record.kind === 'death'));
        let current = units.filter(x => x !== input && active.has(x.record.nodeId) && x.record.kind !== 'death');
        let targetEvent = null, targetArchive = null, targetUnit = null, targetSnapshot = null, mechanicalTarget = false;
        if (proof.narrativeTarget !== null) {
            const target = proof.narrativeTarget;
            targetEvent = [...records.values()].find(r => r.kind === 'return'
                && (target.eventId ? r.eventId === target.eventId : r.uid === target.returnUid));
            targetArchive = archives.get(target.archiveId);
            must(targetEvent && (input || (proof.inputUid === null && frontier === targetEvent.nodeId
                && targetEvent.narrativeStatus === 'pending' && ['request-only','virtual'].includes(targetEvent.visibility)))
                && active.has(targetEvent.nodeId)
                && targetEvent.targetArchiveId === targetArchive?.archiveId, 'unproven-narrative-target');
            must([...records.values()].filter(r => r.kind === 'return').at(-1) === targetEvent, 'stale-narrative-target');
            targetUnit = selected.get(targetArchive.frontierId);
            const targetRecord = records.get(targetArchive.frontierId);
            mechanicalTarget = targetRecord.promptDisposition === 'mechanical-source';
            if (mechanicalTarget) must(targetArchive.anchor.type === 'whole-message'
                && active.has(targetRecord.nodeId) && !targetUnit, 'invalid-mechanical-target');
            else must(targetUnit && current.includes(targetUnit), 'target-not-separable-in-request');
            targetSnapshot = proof.targetSnapshot;
            const state = targetSnapshot?.state;
            const origin = targetSnapshot?.originArchive, restored = targetSnapshot?.restored;
            must(targetSnapshot?.archiveId === targetArchive.archiveId && targetSnapshot.complete === true
                && targetSnapshot.committed === true && targetSnapshot.stateRevision === targetEvent.revision
                && id(targetSnapshot.stateRevision)
                && targetSnapshot.gameTime === targetRecord.gameTime
                && targetSnapshot.location === targetArchive.anchor.location
                && targetSnapshot.timelineId === targetEvent.timelineId
                && origin?.archiveId === targetArchive.archiveId && id(origin.stateRevision)
                && origin.gameTime === targetRecord.gameTime && origin.timelineId === targetRecord.timelineId
                && restored?.returnEventId === targetEvent.eventId && id(restored.batchId)
                && restored.stateRevision === targetSnapshot.stateRevision
                && restored.gameTime === targetSnapshot.gameTime && restored.timelineId === targetSnapshot.timelineId
                && ['顶层','主角','角色','敌人'].every(key => state?.[key] && typeof state[key] === 'object' && !Array.isArray(state[key]))
                && state.顶层.时间 === targetSnapshot.gameTime && state.顶层.地点 === targetSnapshot.location
                && state.顶层._派生?.时间线状态?.当前序号 === targetSnapshot.timelineId
                && state.主角.生命状态 === '存活',
            'target-full-state-unproven');
            if (!mechanicalTarget) current = [...current.filter(x => x !== targetUnit), targetUnit];
        }
        for (const event of records.values()) {
            if (event.kind !== 'return' || !['request-only','virtual'].includes(event.visibility)) continue;
            if (event.narrativeStatus === 'pending') must(event === targetEvent, 'pending-scene-needs-narrative-target');
            else if (event.narrativeStatus !== undefined) {
                const scene = records.get(event.sceneMessageUid);
                must(event.narrativeStatus === 'generated' && scene?.uid && !scene.isUser
                    && scene.visibility === 'visible' && ['ordinary','death','checkpoint'].includes(scene.kind)
                    && scene.position > event.position,
                'unproven-generated-return-scene');
                let parent = scene.parentId, childPosition = scene.position;
                while (parent !== event.nodeId) {
                    const between = records.get(parent);
                    const inputHop=between?.uid && between.isUser && ['input','ordinary'].includes(between.kind)
                        && between.visibility === 'visible' ;
                    const pointHop=between?.anchorId && between.kind==='checkpoint' && between.visibility==='request-only'
                        && [...archives.values()].some(a=>a.frontierId===between.anchorId && a.anchor.type==='exact-snapshot' && a.anchor.sourceMessageUid===scene.uid && a.anchor.sourceRevision===scene.revision);
                    must((inputHop||pointHop) && between.position < childPosition
                        && between.position > event.position, 'unproven-generated-return-scene');
                    childPosition = between.position;
                    parent = between.parentId;
                }
            }
        }
        // Historical virtual snapshots carry causal certificates only; never replay their bodies.
        const emitted = unit => unit.record.visibility !== 'request-only' || unit === targetUnit;
        current = current.filter(emitted);
        const emittedOld = old.filter(emitted);
        const ownership = [];
        const bodyRow = (unit, region, first) => {
            const r = unit.record, raw = unit.index === null ? null : coreChat[unit.index];
            const body = unit === targetUnit && r.visibility === 'request-only'
                ? r.sourceMes
                : raw ? raw.mes : r.sourceMes;
            const label = r.kind === 'input' ? '玩家当前输入，脚本确认的当前游戏时间'
                : region === 'old' ? '旧线完整经历，非当前世界事实' : '当前有效历史';
            const identity = r.uid ? `消息UID=${r.uid}` : `快照锚点ID=${r.anchorId}`;
            let prefix = `【死亡回归：${label}；游戏时间=${r.gameTime}；所属线号=${r.timelineId}；${identity}】\n`;
            const suffix = `\n【死亡回归：原文结束；${identity}】`;
            if (first) prefix = `【${region === 'old' ? '第一层：旧线完整经历，含死亡原文' : '第三层：当前有效历史'}】\n${prefix}`;
            if (unit === targetUnit) prefix = `【本次续写目标：机械恢复已提交；回归后具体情景待本次生成。目标档游戏时间=${r.gameTime}、地点=${targetArchive.anchor.location}；依据已证完整状态锚点生成具体情景，剧情正文不等于完整状态；恢复后的所属线号=${targetEvent.timelineId}。】\n${prefix}`;
            const mes = prefix + body + suffix;
            const row = raw ? { ...raw, mes } : promptOnly(r.nodeId, mes, r.kind);
            if (raw) ownership.push({ row, sourceIndex: unit.index, prefix, suffix });
            return row;
        };
        const ledgerRows = [...records.values()].filter(r => r.kind === 'return').map((event, i) => {
            const a = archives.get(event.targetArchiveId), captured = records.get(a.frontierId), death = records.get(event.deathUid);
            const pending = event === targetEvent ? '回归后具体情景待本次生成；依目标档时间、地点、状态续写。'
                : '本注释只记录机械恢复，不代替回归剧情正文。';
            return promptOnly(`ledger:${event.eventId}`, `${i === 0 ? '【第二层：简短机械回归账本】\n' : ''}【机械事件ID=${event.eventId}；游戏时间=${event.gameTime}；所属线号=${event.timelineId}】\n机械恢复已提交；死亡消息UID=${death.uid}；旧线号=${death.timelineId}→新线号=${event.timelineId}；死亡时刻=${death.gameTime}→目标恢复时刻=${captured.gameTime}；目标档ID=${a.archiveId}；目标地点=${a.anchor.location}。${pending}`, 'ledger');
        });
        const currentRows = [];
        const targetStateRow = () => promptOnly(`target-state:${targetArchive.archiveId}`,
            `【已证完整目标状态锚点；目标档ID=${targetArchive.archiveId}；来源身份=${targetArchive.anchor.messageUid ?? targetArchive.anchor.anchorId ?? 'mechanical-source'}；目标档原游戏时间=${targetSnapshot.originArchive.gameTime}；原所属线号=${targetSnapshot.originArchive.timelineId}；原档状态revision=${targetSnapshot.originArchive.stateRevision}；下面为当前真实恢复态；游戏时间=${targetSnapshot.gameTime}；新线号=${targetSnapshot.timelineId}；目标地点=${targetSnapshot.location}；状态revision=${targetSnapshot.stateRevision}；恢复事件ID=${targetSnapshot.restored.returnEventId}；提交批次=${targetSnapshot.restored.batchId}；机械恢复已提交；回归后具体情景待本次生成；依目标档时间、地点、当前真实恢复态续写】\n${JSON.stringify(targetSnapshot.state, null, 2)}`, 'target-state');
        for (const [i, unit] of current.entries()) currentRows.push(bodyRow(unit, 'current', i === 0));
        if (targetSnapshot) currentRows.push(targetStateRow());
        const rows = [...emittedOld.map((u, i) => bodyRow(u, 'old', i === 0)), ...ledgerRows, ...currentRows];
        if (input) rows.push(bodyRow(input, 'current', false));
        if (type === 'continue' && targetSnapshot && returnOutput) {
            returnOutput.check();
            must(returnOutput.ownerLease===proof.leaseId&&returnOutput.returnUid===(targetEvent.uid??targetEvent.eventId)&&returnOutput.deathUid===targetEvent.deathUid,'pending-output-proof-mismatch');
            // Historical bodies are retained once; pending instructions add no physical floor.
            rows.push(promptOnly(`pending-new-output:${targetEvent.eventId}`,
                `《注意！！！现在收到了有关用户的人生大事：死亡回归的机械恢复已确认并提交。当前真实游戏时间=${targetSnapshot.gameTime}；地点=${targetSnapshot.location}；所属时间线=${targetSnapshot.timelineId}；唯一完整恢复态见上方已证完整目标状态锚点。请从这份恢复态生成回归后的具体身体感受、地点与环境情景。输出将保存到新的assistant回归楼UID=${returnOutput.uid}。不得续接死亡前动作，不重播历史正文，不把机械恢复说明当成已生成剧情。》`,'pending-continue-instruction'));
        } else if (type === 'continue') {
            const sourceIndex = coreChat.length - 1, target = coreChat[sourceIndex];
            must(target && !target.is_system && !target.extra?.[Symbol.for('ignore')], 'continue-target-unproven');
            const owned = ownership.find(x => x.sourceIndex === sourceIndex);
            must(owned, 'continue-target-not-owned');
            if (targetSnapshot) {
                // User-approved exception: only this pending return's physical death target may follow state.
                // Native selects the continued/prefill body from request tail; preserve that exact body once.
                must(targetEvent.narrativeStatus === 'pending' && owned.row.extra?.deathReturnPrompt?.uid === targetEvent.deathUid
                    && !target.is_user, 'pending-continue-physical-target-mismatch');
                const instruction = promptOnly(`pending-continue:${targetEvent.eventId}`,
                    `《注意！！！现在收到了有关用户的人生大事：死亡回归的机械恢复已确认并提交。当前真实游戏时间=${targetSnapshot.gameTime}；地点=${targetSnapshot.location}；所属时间线=${targetSnapshot.timelineId}；唯一完整恢复态见紧邻的已证完整目标状态锚点。当前物理续写目标UID=${owned.row.extra.deathReturnPrompt.uid}仅为原生继续回复的写入目标；其死亡前情景属于已作废旧线，绝不能续接死亡前动作。请让本次新增输出从上述真实恢复时间、地点、所属线和完整恢复态出发，生成回归后的具体情景。不要重播历史正文，不要把机械恢复说明当作已经生成的回归剧情，不要编造未恢复的状态。》`, 'pending-continue-instruction');
                rows.splice(rows.indexOf(owned.row), 1);
                rows.push(instruction, owned.row);
            } else must(owned.row === rows.at(-1), 'continue-target-not-tail');
            // Native cyclePrompt/prefill must see the exact original selected body, without our closing labels.
            owned.row.mes = target.mes;
            owned.prefix = ''; owned.suffix = '';
        }
        return { available: true, code: 'ready', rows,
            ownership,
            order: rows.map(r => r.extra?.deathReturnPrompt?.uid ?? r.extra.deathReturnRequest.nodeId),
            archived: emittedOld.map(x => x.record.nodeId), currentBodies: current.map(x => x.record.nodeId),
            ledger: ledgerRows.map(r => r.extra.deathReturnRequest.nodeId), current: path,
            restored: units.filter(x => x.index === null && x.record.visibility === 'system-filtered').map(x => x.record.nodeId),
            mechanicalSources: [...records.values()].filter(r => r.promptDisposition === 'mechanical-source').map(r => r.nodeId),
            status: [...records.values()].map(r => ({ uid: r.uid, anchorId: r.anchorId, eventId: r.eventId,
                kind: r.kind, gameTime: r.gameTime, timelineId: r.timelineId,
                currentWorld: r.kind !== 'death' && !(r.kind === 'return' && ['request-only','virtual'].includes(r.visibility))
                    && active.has(r.nodeId) })),
        };
    } catch (error) { return { available: false, code: error.message }; }
}
