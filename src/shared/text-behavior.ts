import { editRanges, readingOrder } from './text-selection';
import type { TextBodyComparison, TextClip, TextEdit } from './text-selection';

/** Full, reproducible body comparison. Nothing is inferred about the user's motive. */
export function compareTextBody(clip: TextClip, before: TextEdit, after: TextEdit): TextBodyComparison {
  const render = (edit: TextEdit) => edit.body.map(pick => ({ id: pick.id,
    text: pick.ranges.map(([start, end]) => clip.units.find(unit => unit.id === pick.id)!.text.slice(start, end)).join('') }));
  const beforeBody = render(before), afterBody = render(after);
  const subtract = (ranges: [number, number][], other: [number, number][]) => other.reduce((rest, range) => editRanges(rest, range, false), ranges);
  const intersect = (a: [number, number][], b: [number, number][]) => a.flatMap(([x, y]) => b.flatMap(([u, v]) => Math.max(x, u) < Math.min(y, v) ? [[Math.max(x, u), Math.min(y, v)] as [number, number]] : []));
  const beforeCommon = before.body.filter(p => after.body.some(other => other.id === p.id)).map(p => p.id);
  const afterCommon = after.body.filter(p => before.body.some(other => other.id === p.id)).map(p => p.id);
  return { before: beforeBody, after: afterBody, changes: clip.units.flatMap(unit => {
    const old = before.body.find(p => p.id === unit.id), next = after.body.find(p => p.id === unit.id);
    if (!old && !next) return [];
    const removedRanges = subtract(old?.ranges ?? [], next?.ranges ?? []);
    const addedRanges = subtract(next?.ranges ?? [], old?.ranges ?? []);
    const toHookRanges = intersect(removedRanges, after.hook?.id === unit.id ? after.hook.ranges : []);
    const fromHookRanges = intersect(addedRanges, before.hook?.id === unit.id ? before.hook.ranges : []);
    const removed = subtract(removedRanges, toHookRanges).map(([a, b]) => unit.text.slice(a, b));
    const added = subtract(addedRanges, fromHookRanges).map(([a, b]) => unit.text.slice(a, b));
    const toHook = toHookRanges.map(([a, b]) => unit.text.slice(a, b));
    const fromHook = fromHookRanges.map(([a, b]) => unit.text.slice(a, b));
    const moved = !!old && !!next && beforeCommon.indexOf(unit.id) !== afterCommon.indexOf(unit.id);
    return [{ id: unit.id, sourceText: unit.text, before: beforeBody.find(p => p.id === unit.id)?.text ?? '',
      after: afterBody.find(p => p.id === unit.id)?.text ?? '', removed, added, toHook, fromHook, moved }];
  }) };
}

export function finalVersionMatches(clip: TextClip) {
  const version = clip.confirmedFinal;
  return !!version && version.status === 'confirmed' && JSON.stringify(version.edit) === JSON.stringify({ title: clip.title,
    hook: clip.hook, repeatHook: clip.repeatHook, body: clip.body });
}
