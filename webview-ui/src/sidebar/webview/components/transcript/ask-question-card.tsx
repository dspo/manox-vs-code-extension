// AskUserQuestion card: the interactive question drawer rendered from the
// canonical B2-PR-1 payload (#796). One question renders per step, mirroring
// the gpui host's drawer. Every question carries a stable server-minted
// `id`, optional `detail` markdown, and optional `intent {kind, approve}`.
// Answers ride back as id-routed tri-state rows `{id, selected, custom?}` —
// selection(s), free text, or skip (empty `selected`, no `custom`) for every
// untouched question. No card-level response override.

import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';

import type { AskAnswerRow, AskQuestionWire } from '../../../../protocol';
import { ThreadApi } from '../../api/client';
import { store } from '../../state/bridge';
import { t } from '../../lib/i18n';
import type { TranscriptItem } from '../../state/store';
import { cn } from '../../lib/utils';
import { MarkdownContent } from '../ai/markdown-content';
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationTitle,
} from '../ai/confirmation';
import { Button } from '../ui/button';

export type AskQuestionItem = Extract<TranscriptItem, { kind: 'ask_question' }>;

/** Port of the gpui host's `strip_recommended_suffix`: an option label may
 * carry a "(recommended)" / "（推荐）" suffix in lieu of the explicit flag. */
function stripRecommendedSuffix(label: string): { label: string; recommended: boolean } {
  const lower = label.toLowerCase();
  for (const suffix of [' (Recommended)', '（推荐）', ' (推荐)', '（Recommended）']) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return { label: label.slice(0, label.length - suffix.length).trim(), recommended: true };
    }
  }
  return { label, recommended: false };
}

/** Defensive parse of the canonical payload: tolerant per question (a
 * malformed row degrades to informational), unbounded question/option
 * counts. A question without a server-minted `id` is unanswerable for
 * canonical routing and renders read-only. */
function parseAsk(input: unknown): AskQuestionWire[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const out: AskQuestionWire[] = [];
  for (const q of questions) {
    if (typeof q !== 'object' || q === null) continue;
    const obj = q as Record<string, unknown>;
    if (typeof obj.question !== 'string') continue;
    const options = Array.isArray(obj.options) ? obj.options : [];
    const intent =
      typeof obj.intent === 'object' && obj.intent !== null
        ? (obj.intent as { kind?: unknown; approve?: unknown })
        : undefined;
    out.push({
      id: typeof obj.id === 'string' ? obj.id : undefined,
      question: obj.question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      detail: typeof obj.detail === 'string' ? obj.detail : undefined,
      intent:
        intent && typeof intent.kind === 'string'
          ? { kind: intent.kind, approve: typeof intent.approve === 'string' ? intent.approve : undefined }
          : undefined,
      multiSelect: obj.multiSelect === true,
      options: options
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => {
          const explicitRecommended = o.recommended === true;
          const { label, recommended } = stripRecommendedSuffix(
            typeof o.label === 'string' ? o.label : '',
          );
          return {
            label,
            description: typeof o.description === 'string' ? o.description : undefined,
            recommended: explicitRecommended || recommended,
          };
        }),
    });
  }
  return out.length > 0 ? out : null;
}

export type AskQuestionCardProps = {
  item: AskQuestionItem;
  sessionId: string;
};

export const AskQuestionCard = ({ item, sessionId }: AskQuestionCardProps) => {
  const questions = parseAsk(item.input);
  // Per-step selections (labels) and per-step free-text answers, keyed by
  // step index; submit re-keys them by the question's wire id.
  const [selections, setSelections] = useState<string[][]>(
    () => questions?.map(() => []) ?? [],
  );
  const [customs, setCustoms] = useState<string[]>(
    () => questions?.map(() => '') ?? [],
  );
  const [step, setStep] = useState(0);

  // Answered state: the drawer is gone; the card shows the actor's rendered
  // verdict once `tool_result` lands. A denied or cancelled question
  // renders its output as an error, mirroring the tool card's styling.
  if (item.answered) {
    return (
      <div className="border-border bg-card text-foreground rounded-lg border px-3 py-2 text-sm">
        <div className="mb-1 font-medium">{item.summary || t('ask_title')}</div>
        {item.output && (
          <pre
            className={cn(
              'whitespace-pre-wrap font-code text-xs',
              item.isError ? 'text-danger' : 'text-muted-foreground',
            )}
          >
            {item.output}
          </pre>
        )}
      </div>
    );
  }

  if (!questions) {
    // Protocol-regression fallback: render the raw payload read-only — an
    // Approve/Deny pair would mislabel the outcome.
    return (
      <div className="border-border bg-card text-foreground rounded-lg border px-3 py-2 text-sm">
        <div className="mb-1">{item.summary || t('ask_title')}</div>
        <pre className="text-muted-foreground font-code max-h-[180px] overflow-auto rounded-md bg-muted/50 p-2 text-xs">
          {JSON.stringify(item.input, null, 2)}
        </pre>
      </div>
    );
  }

  const total = questions.length;
  const current = questions[Math.min(step, total - 1)];
  const isLast = step === total - 1;
  const canPrev = step > 0;

  const toggle = (label: string, multi: boolean) => {
    setSelections((prev) =>
      prev.map((sel, i) =>
        i !== step
          ? sel
          : multi
            ? sel.includes(label)
              ? sel.filter((l) => l !== label)
              : [...sel, label]
            : [label],
      ),
    );
  };

  /** Canonical submit: one id-routed tri-state row per parked question;
   * untouched questions answer as skip (empty selected, no custom). */
  const submit = () => {
    const rows: AskAnswerRow[] = [];
    questions.forEach((q, i) => {
      if (!q.id) return; // unanswerable without canonical routing
      const selected = selections[i] ?? [];
      const custom = (customs[i] ?? '').trim();
      if (selected.length === 0 && custom === '') {
        rows.push({ id: q.id, selected: [] });
        return;
      }
      const row: AskAnswerRow = { id: q.id, selected };
      if (custom !== '') row.custom = custom;
      rows.push(row);
    });
    new ThreadApi(sessionId).answerQuestion(item.callId, rows);
    store.respondAsk(sessionId, item.id);
  };

  /** Cancel withdraws the delivery: an Err reply converges the waterfall
   * through the expire path (fail-closed), never a fake answer. */
  const cancel = () => {
    new ThreadApi(sessionId).cancelAsk(item.callId);
    store.respondAsk(sessionId, item.id);
  };

  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const prev = () => setStep((s) => Math.max(0, s - 1));

  // The drawer title follows the gpui host: the step's header when present,
  // otherwise the generic question title.
  const title = current.header?.trim() ? current.header : item.summary || t('ask_title');

  return (
    <Confirmation approval={{ id: item.id, approved: false }} state="approval-requested" variant="default">
      <ConfirmationTitle>
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </span>
          <nav className="flex shrink-0 items-center gap-0.5">
            <Button
              aria-label={t('ask_prev_question')}
              disabled={!canPrev}
              onClick={prev}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <span className="text-muted-foreground min-w-[44px] text-center text-xs">
              {step + 1} of {total}
            </span>
            <Button
              aria-label={isLast ? t('ask_submit') : t('ask_next_question')}
              onClick={isLast ? submit : next}
              size="icon-sm"
              variant="ghost"
            >
              {isLast ? <Check /> : <ChevronRight />}
            </Button>
            <Button aria-label={t('ask_cancel')} onClick={cancel} size="icon-sm" variant="ghost">
              <X />
            </Button>
          </nav>
        </div>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <div className="space-y-3">
          <p className="text-sm">{current.question}</p>
          {current.detail && (
            <div className="text-muted-foreground text-xs">
              <MarkdownContent content={current.detail} />
            </div>
          )}
          {current.intent && (
            <div className="text-muted-foreground text-xs">
              intent: {current.intent.kind}
              {current.intent.approve ? ` — approving: “${current.intent.approve}”` : ''}
            </div>
          )}
          <div className="space-y-1">
            {current.options.map((o) => {
              const selected = (selections[step] ?? []).includes(o.label);
              return (
                <button
                  className={cn(
                    'block w-full cursor-pointer rounded-md border border-border px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                    selected && 'border-info text-info bg-accent',
                  )}
                  key={o.label}
                  onClick={() => toggle(o.label, current.multiSelect === true)}
                  type="button"
                >
                  <span className="font-medium">
                    {current.multiSelect ? (selected ? '☑ ' : '☐ ') : selected ? '● ' : '○ '}
                    {o.label}
                    {o.recommended ? ` (${t('ask_recommended')})` : ''}
                  </span>
                  {o.description && (
                    <span className="text-muted-foreground block text-xs">{o.description}</span>
                  )}
                </button>
              );
            })}
          </div>
          {current.id ? (
            <input
              className="border-border bg-background text-foreground w-full rounded-md border px-2 py-1 text-sm"
              onChange={(e) =>
                setCustoms((prev) => prev.map((v, i) => (i === step ? e.target.value : v)))
              }
              placeholder={t('ask_custom_placeholder')}
              value={customs[step] ?? ''}
            />
          ) : (
            <div className="text-muted-foreground text-xs">
              (this question carries no id — it renders for context only and answers as skip)
            </div>
          )}
        </div>
      </ConfirmationRequest>
    </Confirmation>
  );
};
