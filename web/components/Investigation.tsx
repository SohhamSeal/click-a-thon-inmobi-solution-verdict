'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  deriveInvestigation,
  type InvDetail,
  type InvStage,
  type StageId,
  type StageState,
} from '@/lib/investigation';
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

/** Default stage from revealed work: active frontier, else last settled (incl. empty). */
function defaultStage(stages: InvStage[]): StageId {
  const active = stages.find(s => s.state === 'active');
  if (active) return active.id;
  const lastDone = [...stages].reverse().find(s => s.state === 'complete' || s.state === 'empty');
  return lastDone?.id ?? stages[0]?.id ?? 'detect';
}

function Fan({ lanes }: { lanes: InvDetail[] }) {
  if (!lanes.length) return null;
  return (
    <div className="inv-fan" aria-label="Investigate parallel work">
      <span className="inv-fan-stem" aria-hidden="true" />
      <div className="inv-fan-branches">
        {lanes.map((lane, i) => (
          <div key={lane.id} className={`inv-fan-lane ${lane.state}${i === lanes.length - 1 ? ' last' : ''}`}>
            <span className="inv-fan-elbow" aria-hidden="true" />
            <span className="inv-mark" aria-hidden="true">
              {mark(lane.state)}
            </span>
            <span className="inv-fan-name">{lane.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageBlock({
  stage,
  selected,
  onSelect,
}: {
  stage: InvStage;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="inv-block-col" role="listitem">
      <button
        type="button"
        className={`inv-block ${stage.state}${stage.positive ? ' ok' : ''}${selected ? ' on' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="inv-block-top">
          <span className="inv-mark" aria-hidden="true">
            {mark(stage.state)}
          </span>
          <span className="inv-block-label">{stage.label}</span>
        </span>
        <span className="inv-block-blurb">{stage.blurb}</span>
      </button>
      {stage.id === 'investigate' ? <Fan lanes={stage.details} /> : null}
    </div>
  );
}

function Spine({
  stages,
  selected,
  onSelect,
}: {
  stages: InvStage[];
  selected: StageId;
  onSelect: (id: StageId) => void;
}) {
  return (
    <div className="inv-spine">
      <div className="inv-rail" role="list" aria-label="Investigation stages">
        {stages.map((stage, i) => (
          <Fragment key={stage.id}>
            {i > 0 ? (
              <span className="inv-edge" aria-hidden="true">
                →
              </span>
            ) : null}
            <StageBlock
              stage={stage}
              selected={selected === stage.id}
              onSelect={() => onSelect(stage.id)}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StageDetail({
  stage,
  onDeepLink,
}: {
  stage: InvStage;
  onDeepLink: () => void;
}) {
  const supportLines = stage.support?.split('\n').filter(Boolean) ?? [];

  return (
    <div className={`nd inv-nd ${stage.state}`}>
      <div className="ndh">
        <span className="k">{stage.label}</span>
        <span className="dim2">·</span>
        <span className="n inv-state">{stage.state}</span>
      </div>

      <div className="inv-meaning">{stage.meaning}</div>

      {supportLines.map((line, i) => (
        <div className="inv-support" key={`support-${i}`}>
          {line}
        </div>
      ))}

      {stage.details.length > 0 ? (
        <div className="inv-rows">
          {stage.details.map(row => (
            <div key={row.id} className={`inv-row ${row.state}`}>
              <span className="inv-row-name">{row.label}</span>
              <span className="inv-row-mark" aria-hidden="true">
                {mark(row.state)}
              </span>
              <span className="inv-row-short">{row.state === 'pending' ? '' : row.short}</span>
            </div>
          ))}
        </div>
      ) : null}

      <button type="button" className="inv-link" onClick={onDeepLink}>
        {stage.open.tab === 'evidence' ? 'View evidence →' : 'View technical trace →'}
      </button>
    </div>
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
  const stages = useMemo(() => deriveInvestigation(steps, c), [steps, c]);
  const auto = defaultStage(stages);

  const [manual, setManual] = useState<StageId | null>(null);

  useEffect(() => {
    setManual(null);
  }, [c.case_id]);

  const selected: StageId = manual ?? auto;
  const stage = stages.find(s => s.id === selected) ?? stages.find(s => s.id === auto) ?? stages[0];
  if (!stage) return null;

  return (
    <div className="inv">
      <Spine stages={stages} selected={stage.id} onSelect={setManual} />
      <div className="inv-body">
        <StageDetail stage={stage} onDeepLink={() => onOpen(stage.open.tab, stage.open.stepId)} />
      </div>
    </div>
  );
}
