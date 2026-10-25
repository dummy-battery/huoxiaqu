const kinds = new Set(['ordinary', 'checkpoint', 'death', 'return', 'input']);
const boundaryKinds = new Set(['checkpoint', 'death', 'return']);
const ignore = Symbol.for('ignore');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const requireProof = (ok, code) => { if (!ok) throw new Error(code); };

export function validGameTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
    const [year, month, day, hour, minute, second] = value.match(/\d+/g).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
        && hour <= 23 && minute <= 59 && second <= 59;
}

export function describeRequest(coreChat) {
    return coreChat.map(row => ({
        uid: row.extra?.deathReturnPrompt?.uid,
        revision: row.extra?.deathReturnPrompt?.revision,
        swipeId: row.swipe_id ?? null,
        mes: row.mes,
        isUser: row.is_user === true,
        isSystem: row.is_system === true,
        ignored: Boolean(row.extra?.[ignore]),
        narrator: row.extra?.type === 'narrator',
    }));
}

function block(record, body, active) {
    const label = record.kind === 'input' ? '玩家当前输入，脚本确认的当前游戏时间'
        : record.kind === 'death' ? '死亡边界，原文保留，非当前世界事实'
        : record.kind === 'return' ? '回归因果边界，非剧情事实'
            : record.kind === 'checkpoint' ? (active ? '当前因果链存档边界' : '历史存档边界，非当前世界事实')
                : active ? '当前因果链剧情' : '旧线普通剧情，非当前世界事实';
    return `【死亡回归：${label}；游戏时间=${record.gameTime}；所属线号=${record.timelineId}；UID=${record.uid}】\n${body}\n【死亡回归：边界结束；UID=${record.uid}】`;
}

export function projectInterleavedReference(coreChat, proof, type) {
    try {
        requireProof(type === 'normal' || type === 'regenerate', 'unsupported-generation-type');
        requireProof(proof?.available === true, 'provider-unavailable');
        requireProof(proof.schemaVersion === 1 && typeof proof.chatId === 'string' && proof.chatId.length > 0 && id(proof.leaseId)
            && Number.isSafeInteger(proof.ledgerRevision) && proof.ledgerRevision >= 0, 'invalid-provider-header');
        requireProof(Array.isArray(proof.records) && Array.isArray(proof.archives)
            && Array.isArray(proof.request), 'invalid-provider-shape');
        const request = describeRequest(coreChat);
        requireProof(JSON.stringify(request) === JSON.stringify(proof.request), 'request-certificate-mismatch');
        const records = new Map();
        for (const [position, record] of proof.records.entries()) {
            requireProof(id(record.uid) && !records.has(record.uid), 'ambiguous-ledger-uid');
            requireProof(validGameTime(record.gameTime), 'missing-or-invalid-game-time');
            requireProof(Number.isSafeInteger(record.timelineId) && record.timelineId >= 0,
                'missing-or-invalid-timeline-id');
            requireProof(kinds.has(record.kind) && typeof record.sourceMes === 'string'
                && id(record.revision) && (record.swipeId === null || Number.isSafeInteger(record.swipeId))
                && typeof record.isUser === 'boolean'
                && ['visible', 'system-filtered', 'ignored'].includes(record.visibility), 'invalid-record');
            records.set(record.uid, { ...record, position });
        }
        const archives = new Map();
        for (const archive of proof.archives) {
            requireProof(id(archive.archiveId) && !archives.has(archive.archiveId), 'ambiguous-archive-id');
            requireProof(archive.committed === true && records.has(archive.createdAfterUid)
                && records.has(archive.frontierUid), 'unproven-archive');
            requireProof(archive.anchor?.type === 'whole-message' && archive.anchor.span === 'whole',
                'exact-snapshot-or-mixed-span-needs-separate-anchor');
            requireProof(archive.anchor.messageUid === archive.frontierUid
                && records.get(archive.frontierUid).kind === 'checkpoint'
                && archive.anchor.revision === records.get(archive.frontierUid).revision,
            'archive-anchor-not-exact');
            requireProof(records.get(archive.frontierUid).position <= records.get(archive.createdAfterUid).position,
                'future-archive-frontier');
            archives.set(archive.archiveId, archive);
        }
        const pathFor = uid => {
            const result = [];
            while (uid !== null) {
                const record = records.get(uid);
                requireProof(record && !result.includes(uid), 'missing-or-cyclic-parent');
                result.push(uid);
                uid = record.parentUid;
            }
            return result.reverse();
        };
        let frontier = null;
        for (const record of records.values()) {
            if (record.kind === 'return') {
                const archive = archives.get(record.targetArchiveId);
                const death = records.get(record.deathUid);
                requireProof(record.committed === true && archive && death?.kind === 'death'
                    && death.uid === frontier
                    && records.get(archive.createdAfterUid).position < record.position,
                'unproven-return-boundary');
                requireProof(record.parentUid === archive.frontierUid
                    && records.get(archive.frontierUid).position < record.position,
                    'return-frontier-mismatch');
            } else {
                requireProof(record.parentUid === frontier, 'causal-parent-mismatch');
            }
            frontier = record.uid;
        }
        for (const archive of archives.values()) {
            requireProof(pathFor(archive.createdAfterUid).includes(archive.frontierUid), 'archive-capture-off-active-path');
        }
        requireProof(proof.frontierUid === frontier, 'stale-ledger-frontier');
        const path = frontier === null ? [] : pathFor(frontier);
        const lastHistorical = [...records.values()].filter(r => r.kind !== 'input').at(-1);
        requireProof(lastHistorical?.kind !== 'death', 'pending-death-recovery');
        const active = new Set(path);
        const selected = new Map();
        for (const [index, row] of request.entries()) {
            requireProof(id(row.uid) && !selected.has(row.uid), 'missing-or-ambiguous-message-uid');
            const record = records.get(row.uid);
            requireProof(record && record.visibility === 'visible' && !row.ignored && !row.isSystem,
                'request-visibility-mismatch');
            requireProof(row.revision === record.revision && row.swipeId === record.swipeId
                && row.isUser === record.isUser, 'changed-message-version');
            requireProof(!row.narrator || !row.isUser, 'ambiguous-narrator-role');
            selected.set(row.uid, { record, index, leading: [] });
        }
        const originalPositions = [...selected.values()].map(x => x.record.position);
        requireProof(originalPositions.every((p, i) => i === 0 || p > originalPositions[i - 1]),
            'request-order-not-native');
        for (const record of records.values()) {
            if (!boundaryKinds.has(record.kind)) continue;
            requireProof(record.visibility !== 'ignored', 'intentionally-hidden-boundary');
            if (record.visibility !== 'system-filtered') continue;
            const carrier = selected.get(record.restore?.carrierUid);
            const next = [...selected.values()].find(x => x.record.position > record.position);
            requireProof(record.restore?.reason === 'native-system-filter' && carrier && carrier === next
                && carrier.record.kind !== 'input' && !carrier.record.isUser, 'unproven-system-restoration');
            carrier.leading.push(record);
        }
        const input = selected.get(proof.inputUid);
        if (proof.inputUid !== null) {
            requireProof(input?.record.kind === 'input' && input.record.isUser
                && input.index === request.length - 1 && input.record.uid === proof.frontierUid,
            'latest-user-not-pinned');
        } else {
            requireProof(![...selected.values()].some(x => x.record.kind === 'input'), 'unclaimed-input');
        }
        const ordinary = [...selected.values()].filter(x => x !== input && x.record.kind === 'ordinary'
            && !active.has(x.record.uid) && !x.leading.length);
        const skeleton = [...selected.values()].filter(x => x !== input && !ordinary.includes(x));
        let ordered = [...ordinary, ...skeleton];
        if (proof.narrativeTarget !== null) {
            const target = proof.narrativeTarget;
            const event = records.get(target.returnUid);
            const archive = archives.get(target.archiveId);
            requireProof(input && event?.kind === 'return' && active.has(event.uid)
                && event.targetArchiveId === archive?.archiveId, 'unproven-narrative-target');
            requireProof([...records.values()].filter(r => r.kind === 'return').at(-1)?.uid === event.uid,
                'stale-narrative-target');
            const anchor = selected.get(archive.frontierUid);
            requireProof(anchor && anchor.record.kind === 'checkpoint' && !anchor.leading.length,
                'target-not-separable-in-request');
            ordered = [...ordered.filter(x => x !== anchor), anchor];
        }
        if (input) ordered.push(input);
        const rows = ordered.map(unit => {
            const original = coreChat[unit.index];
            if (unit === input) return { ...original, mes: block(unit.record, original.mes, true) };
            const body = boundaryKinds.has(unit.record.kind) ? unit.record.sourceMes : original.mes;
            const pieces = [...unit.leading.map(r => block(r, r.sourceMes, active.has(r.uid))),
                block(unit.record, body, active.has(unit.record.uid))];
            return { ...original, mes: pieces.join('\n\n') };
        });
        return { available: true, code: 'ready', rows,
            order: ordered.map(x => x.record.uid),
            archived: ordinary.map(x => x.record.uid),
            skeleton: skeleton.map(x => x.record.uid),
            current: path.filter(uid => records.get(uid).kind !== 'death'),
            restored: [...selected.values()].flatMap(x => x.leading.map(r => r.uid)),
            status: [...records.values()].map(r => ({ uid: r.uid, kind: r.kind,
                gameTime: r.gameTime, timelineId: r.timelineId,
                currentWorld: r.kind !== 'death' && r.kind !== 'return' && active.has(r.uid) })),
        };
    } catch (error) {
        return { available: false, code: error.message };
    }
}
