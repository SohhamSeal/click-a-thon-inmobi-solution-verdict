import type { Case, Step, VerdictKind } from '@/lib/types';

/** Human-facing investigation map. Every stage is derived from revealed case_steps
 *  plus case outcome fields — nothing here is a second trace. */

export type StageState = 'pending' | 'active' | 'complete' | 'empty';

export type StageId = 'detect' | 'investigate' | 'localize' | 'verify' | 'verdict';

export interface InvDetail {
  id: string;
  label: string;
  state: StageState;
  short: string;
  raw: string;
  stepId?: string;
}

export interface InvStage {
  id: StageId;
  label: string;
  question: string;
  state: StageState;
  /** One-line status shown inside the stage block. */
  blurb: string;
  /** Positive localized outcome — subtle green tint like console badges. */
  positive?: boolean;
  meaning: string;
  support?: string;
  details: InvDetail[];
  open: { tab: 'trace' | 'evidence'; stepId?: string };
}

function humanSegment(segment: string): string {
  if (!segment || segment === 'all traffic') return segment || 'all traffic';
  return segment
    .split(' AND ')
    .map(part => {
      const eq = part.indexOf('=');
      return eq < 0 ? part : part.slice(eq + 1);
    })
    .join(' × ');
}

function auditShort(result: string): string {
  const pct = result.match(/([\d.]+%)\s+of cells flagged/i);
  if (/baseline calibrated/i.test(result) && pct) {
    return `Baseline calibrated · ${pct[1]} flagged`;
  }
  if (/baseline calibrated/i.test(result)) return 'Baseline calibrated';
  return result;
}

function correctShort(what: string, result: string): string {
  const kept = result.match(/(\d+)\s+finding/i);
  const bh = /benjamini|hochberg/i.test(what);
  if (bh && kept) return `BH correction applied · ${kept[1]} survived`;
  if (kept) return `${kept[1]} finding(s) survived`;
  return result;
}

function verifyFrom(result: string): { meaning: string; support?: string } {
  const m = result.match(/([\d.]+)\s+from\s+(\d+)\s*\/\s*(\d+)\s+components/i);
  if (!m) return { meaning: result };
  const score = Number(m[1]);
  const scored = Number(m[2]);
  const total = Number(m[3]);
  const support = `${scored} / ${total} components scored`;
  if (scored === 0) return { meaning: 'No score available', support };
  return { meaning: `Confidence ${score.toFixed(2)}`, support };
}

function verdictMeaning(kind: VerdictKind): { state: 'complete' | 'empty'; meaning: string } {
  switch (kind) {
    case 'localized':
      return { state: 'complete', meaning: 'LOCALIZED' };
    case 'unlocalized':
      return { state: 'empty', meaning: 'No publishable accusation' };
    case 'undecomposed':
      return { state: 'empty', meaning: 'Undecomposed' };
    case 'no_data':
      return { state: 'empty', meaning: 'No data' };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function family(steps: Step[], prefix: string): Step[] {
  return steps.filter(s => s.name.startsWith(prefix));
}

export function deriveInvestigation(steps: Step[], c: Case): InvStage[] {
  const detect = steps.find(s => s.name === 'detect');
  const audit = steps.find(s => s.name === 'audit');
  const correct = steps.find(s => s.name === 'correct');
  const localize = steps.find(s => s.name.startsWith('localize:'));
  const confidence = steps.find(s => s.name === 'confidence' || s.name.startsWith('confidence:'));

  const temporal = family(steps, 'temporal:');
  const structural = family(steps, 'structural:');
  const otherNames = new Map<string, Step[]>();
  for (const s of steps) {
    if (s.kind !== 'detector') continue;
    if (s.name === 'detect' || s.name.startsWith('temporal:') || s.name.startsWith('structural:')) continue;
    const prefix = s.name.split(':')[0] || s.name;
    const list = otherNames.get(prefix) ?? [];
    list.push(s);
    otherNames.set(prefix, list);
  }

  const investigateStarted = temporal.length + structural.length + otherNames.size > 0;
  const investigateDone = Boolean(localize) || (Boolean(correct) && !investigateStarted);

  const detectState: StageState = detect ? 'complete' : audit ? 'active' : 'pending';
  const investigateState: StageState = !investigateStarted
    ? 'pending'
    : investigateDone
      ? 'complete'
      : 'active';

  const localizeView = !localize
    ? null
    : (() => {
        const kind = (() => {
          switch (c.verdict_kind) {
            case 'localized':
              return { empty: false as const, meaning: humanSegment(c.segment) };
            case 'unlocalized':
              return { empty: true as const, meaning: 'No defensible candidate' };
            case 'undecomposed':
              return { empty: true as const, meaning: 'Undecomposed' };
            case 'no_data':
              return { empty: true as const, meaning: 'No data' };
            default: {
              const _exhaustive: never = c.verdict_kind;
              return _exhaustive;
            }
          }
        })();
        // Stay active until confidence lands, so Verify is the next frontier.
        if (!confidence && !kind.empty) {
          return { state: 'active' as const, meaning: kind.meaning };
        }
        return {
          state: (kind.empty ? 'empty' : 'complete') as 'empty' | 'complete',
          meaning: kind.meaning,
        };
      })();
  const localizeState: StageState = localizeView?.state ?? 'pending';

  const verify = confidence ? verifyFrom(confidence.result) : null;
  const verifyState: StageState = confidence ? 'complete' : 'pending';

  const verdict = confidence ? verdictMeaning(c.verdict_kind) : null;

  // Lanes finish when a later phase has revealed — not only when localize lands —
  // so Time Machine does not leave Temporal/Structural stuck on ◉ after they ran.
  const afterTemporal = structural.length > 0 || otherNames.size > 0 || Boolean(correct) || Boolean(localize);
  const afterStructural = otherNames.size > 0 || Boolean(correct) || Boolean(localize);
  const afterOthers = Boolean(correct) || Boolean(localize);

  const lane = (id: string, label: string, rows: Step[], laterStarted: boolean): InvDetail => {
    const state: StageState =
      rows.length === 0
        ? 'pending'
        : investigateDone || laterStarted
          ? 'complete'
          : 'active';
    const n = rows.length;
    const noun = id === 'structural' ? (n === 1 ? 'grid' : 'grids') : 'cells';
    const short =
      state === 'pending'
        ? 'Not started'
        : state === 'active'
          ? `Testing ${n} ${noun}…`
          : `${n} ${noun} tested`;
    return {
      id,
      label,
      state,
      short,
      raw: rows[0] ? `${rows.length} ${id} step(s); first: ${rows[0].name}` : '',
      stepId: rows[0]?.step_id,
    };
  };

  const detailsDetect: InvDetail[] = audit
    ? [
        {
          id: 'audit',
          label: 'Data audit',
          state: 'complete',
          short: auditShort(audit.result),
          raw: audit.result,
          stepId: audit.step_id,
        },
      ]
    : [];

  const detailsInvestigate: InvDetail[] = [];
  // Always expose the fan structure once detection has begun, so pending/active
  // lanes stay visible under Investigate instead of appearing only when done.
  if (detect || investigateStarted || correct) {
    detailsInvestigate.push(lane('temporal', 'Temporal', temporal, afterTemporal));
    detailsInvestigate.push(lane('structural', 'Structural', structural, afterStructural));
    for (const [prefix, rows] of otherNames) {
      detailsInvestigate.push(lane(prefix, prefix, rows, afterOthers));
    }
    if (correct) {
      detailsInvestigate.push({
        id: 'correct',
        label: 'Statistical correction',
        state: 'complete',
        short: correctShort(correct.what, correct.result).replace(
          'BH correction applied · ',
          'BH correction · ',
        ),
        raw: correct.result,
        stepId: correct.step_id,
      });
    } else {
      detailsInvestigate.push({
        id: 'correct',
        label: 'Statistical correction',
        state: 'pending',
        short: 'Not started',
        raw: '',
      });
    }
  }

  const localizeDetails: InvDetail[] = localize
    ? [
        {
          id: 'localize',
          label: 'Localizer result',
          state: localizeState,
          short: localizeView?.meaning ?? '',
          raw: localize.result,
          stepId: localize.step_id,
        },
      ]
    : [];

  const verifyDetails: InvDetail[] = confidence
    ? [
        {
          id: 'confidence',
          label: 'Confidence score',
          state: 'complete',
          short: verify?.meaning ?? confidence.result,
          raw: confidence.result,
          stepId: confidence.step_id,
        },
      ]
    : [];

  return [
    {
      id: 'detect',
      label: 'DETECT',
      question: 'Did something change?',
      state: detectState,
      blurb:
        detectState === 'pending' ? 'Not started' : detectState === 'active' ? 'Auditing…' : 'Change detected',
      meaning: detect ? 'Change accepted as a case' : 'Not started',
      details: detailsDetect,
      open: { tab: 'trace', stepId: detect?.step_id ?? audit?.step_id },
    },
    {
      id: 'investigate',
      label: 'INVESTIGATE',
      question: 'What could explain it?',
      state: investigateState,
      blurb:
        investigateState === 'pending'
          ? 'Not started'
          : investigateState === 'active'
            ? 'Testing candidates'
            : 'Candidates tested',
      meaning:
        investigateState === 'pending'
          ? 'Not started'
          : investigateState === 'active'
            ? 'Testing candidate segments'
            : 'Candidate segments tested',
      support:
        investigateState === 'pending'
          ? undefined
          : `${temporal.length} temporal · ${structural.length} structural`,
      details: detailsInvestigate,
      open: { tab: 'trace', stepId: detect?.step_id ?? temporal[0]?.step_id ?? structural[0]?.step_id },
    },
    {
      id: 'localize',
      label: 'LOCALIZE',
      question: 'Can we isolate the source?',
      state: localizeState,
      blurb: localizeView?.meaning ?? 'Not started',
      positive: localizeState === 'complete' && c.verdict_kind === 'localized',
      meaning: localizeView?.meaning ?? 'Not started',
      support: localize && c.candidates.length ? `${c.candidates.length} candidates tested` : undefined,
      details: localizeDetails,
      open: localizeView?.state === 'empty'
        ? { tab: 'evidence' }
        : { tab: 'trace', stepId: localize?.step_id },
    },
    {
      id: 'verify',
      label: 'VERIFY',
      question: 'Is the conclusion supported?',
      state: verifyState,
      blurb: verify?.meaning ?? 'Not started',
      meaning: verify?.meaning ?? 'Not started',
      support: verify?.support,
      details: verifyDetails,
      open: { tab: 'trace', stepId: confidence?.step_id },
    },
    {
      id: 'verdict',
      label: 'VERDICT',
      question: 'What can we conclude?',
      state: verdict?.state ?? 'pending',
      blurb: verdict?.meaning ?? 'Not started',
      positive: verdict?.state === 'complete' && c.verdict_kind === 'localized',
      meaning: verdict?.meaning ?? 'Not started',
      support:
        !verdict || !confidence
          ? undefined
          : c.verdict_kind === 'localized'
            ? `${humanSegment(c.segment)}\n${verify?.meaning ?? ''}${verify?.support ? ` · ${verify.support}` : ''}`
            : verify
              ? `${verify.meaning}${verify.support ? ` · ${verify.support}` : ''}`
              : undefined,
      details: [],
      open: { tab: 'evidence' },
    },
  ];
}
