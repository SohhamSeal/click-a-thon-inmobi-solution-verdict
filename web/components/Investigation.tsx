'use client';

import { useState } from 'react';
import { deriveInvestigation, type InvDetail, type InvStage, type StageState } from '@/lib/investigation';
import type { Case, Step } from '@/lib/types';

function mark(state: StageState): string {
  switch (state) {
    case 'pending':
      return '○';
    case 'active':
      return '◉';
    case 'complete':
      return '✓';
    case 'empty':
      return '⚠';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function DetailRow({
  row,
  onOpen,
}: {
  row: InvDetail;
  onOpen: (stepId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`inv-lane ${row.state}`}>
      <button type="button" className="inv-lane-main" onClick={() => onOpen(row.stepId)}>
        <span className="inv-mark">{mark(row.state)}</span>
        <span className="inv-lane-name">{row.label}</span>
        {row.state !== 'pending' && <span className="inv-lane-short">{row.short}</span>}
      </button>
      {row.raw ? (
        <button type="button" className="inv-raw-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? 'Hide recorded result' : 'Recorded result'}
        </button>
      ) : null}
      {open && row.raw ? <p className="inv-raw">{row.raw}</p> : null}
    </li>
  );
}

function StageBlock({
  stage,
  onOpen,
}: {
  stage: InvStage;
  onOpen: (tab: 'trace' | 'evidence', stepId?: string) => void;
}) {
  return (
    <section className={`inv-stage ${stage.state}`}>
      <button
        type="button"
        className="inv-head"
        onClick={() => onOpen(stage.open.tab, stage.open.stepId)}
      >
        <span className="inv-mark">{mark(stage.state)}</span>
        <span className="inv-label">{stage.label}</span>
        <span className="inv-meaning">— {stage.meaning}</span>
      </button>
      <p className="inv-q">{stage.question}</p>
      {stage.support ? <p className="inv-support">{stage.support}</p> : null}
      {stage.details.length > 0 && (
        <ul className="inv-fan">
          {stage.details.map(row => (
            <DetailRow key={row.id} row={row} onOpen={stepId => onOpen('trace', stepId)} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Investigation({
  c,
  steps,
  onOpen,
}: {
  c: Case;
  steps: Step[];
  onOpen: (tab: 'trace' | 'evidence', stepId?: string) => void;
}) {
  const stages = deriveInvestigation(steps, c);
  return (
    <div className="inv">
      {stages.map((stage, i) => (
        <div key={stage.id}>
          {i > 0 && <div className="inv-join" aria-hidden="true" />}
          <StageBlock stage={stage} onOpen={onOpen} />
        </div>
      ))}
    </div>
  );
}
