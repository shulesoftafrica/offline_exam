import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerRecord,
  AttachmentRules,
  AttemptKey,
  Question,
  QuestionGroup,
  StoredFileMeta,
} from '../../types';
import { formatBytes } from '../../core/util/clock';
import { useAutosave } from '../hooks/useAutosave';
import { useService } from '../hooks/useService';
import { Banner } from './common';

/**
 * Rendering and answering one question.
 *
 * Three real question types from the backend (`choice`, `written`, `upload`) plus
 * `structured`, which is a group of sibling questions shown together with lettered parts —
 * each part still saves against its own `question_id`.
 *
 * Every input writes to IndexedDB before it reports "Saved": choices immediately, written
 * answers on a short debounce (and on blur, tab-hide and navigation), files as soon as they
 * are picked.
 */

export interface QuestionViewProps {
  attemptKey: AttemptKey;
  item: Question | QuestionGroup;
  answers: Map<number, AnswerRecord>;
  files: StoredFileMeta[];
  mediaFileIds: Record<number, string>;
  rules: AttachmentRules;
  locked: boolean;
  onAnswerChanged: () => void;
}

export function QuestionView(props: QuestionViewProps): JSX.Element {
  const { item } = props;
  if ('parts' in item) {
    return (
      <div className="question stack">
        <div className="row between">
          <h2>Question {item.parts[0]?.number.replace(/[a-z]$/i, '') ?? ''}</h2>
          <span className="weight">
            {item.parts.reduce((sum, p) => sum + p.weight, 0)} marks in total
          </span>
        </div>
        {item.stem ? <div className="stem">{item.stem}</div> : null}
        <div className="stack">
          {item.parts.map((part) => (
            <div className="part" key={part.questionId}>
              <div className="label">{part.partLabel ?? part.number}</div>
              <SingleQuestion {...props} item={part} showHeading={false} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return <SingleQuestion {...props} item={item} showHeading />;
}

function SingleQuestion({
  attemptKey,
  item,
  answers,
  files,
  mediaFileIds,
  rules,
  locked,
  onAnswerChanged,
  showHeading = true,
}: QuestionViewProps & { item: Question; showHeading?: boolean }): JSX.Element {
  const question = item;
  const answer = answers.get(question.questionId) ?? null;
  const mediaFileId = mediaFileIds[question.questionId] ?? null;

  return (
    <div className="question">
      {/* Inside a structured question the part is already labelled "(a)", so repeating
          "Question 4a" above it would only add noise; the marks still show. */}
      <div className="row between">
        {showHeading ? <h2 style={{ margin: 0 }}>Question {question.number}</h2> : <span />}
        <span className="weight">
          {question.weight} {question.weight === 1 ? 'mark' : 'marks'}
        </span>
      </div>

      <div className="stem">
        {question.text.split('\n').map((line, index) => (
          <p key={index}>{line}</p>
        ))}
        {mediaFileId ? <LocalImage fileId={mediaFileId} alt={`Picture for question ${question.number}`} /> : null}
        {!mediaFileId && question.imageUrl ? (
          <p className="muted">
            A picture for this question could not be saved on this computer. Tell the invigilator.
          </p>
        ) : null}
      </div>

      {question.kind === 'choice' ? (
        <ChoiceInput
          attemptKey={attemptKey}
          question={question}
          answer={answer}
          locked={locked}
          onAnswerChanged={onAnswerChanged}
        />
      ) : null}

      {question.kind === 'written' ? (
        <WrittenInput
          attemptKey={attemptKey}
          question={question}
          answer={answer}
          locked={locked}
          onAnswerChanged={onAnswerChanged}
        />
      ) : null}

      {question.kind === 'upload' ? (
        <UploadInput
          attemptKey={attemptKey}
          question={question}
          answer={answer}
          files={files.filter((f) => f.questionId === question.questionId && f.role === 'answer')}
          rules={rules}
          locked={locked}
          onAnswerChanged={onAnswerChanged}
        />
      ) : null}
    </div>
  );
}

// ── Choice ──────────────────────────────────────────────────────────────────

function ChoiceInput({
  attemptKey,
  question,
  answer,
  locked,
  onAnswerChanged,
}: {
  attemptKey: AttemptKey;
  question: Question;
  answer: AnswerRecord | null;
  locked: boolean;
  onAnswerChanged: () => void;
}): JSX.Element {
  const service = useService();
  const [saving, setSaving] = useState(false);
  const selected = answer?.optionId ?? null;

  const choose = useCallback(
    async (optionId: number | null) => {
      setSaving(true);
      await service.saveChoice(attemptKey, question.questionId, optionId);
      setSaving(false);
      onAnswerChanged();
    },
    [attemptKey, onAnswerChanged, question.questionId, service],
  );

  return (
    <>
      <div className="options" role="radiogroup" aria-label={`Answer for question ${question.number}`}>
        {question.options.map((option) => (
          <label className="option" key={option.optionId}>
            <input
              type="radio"
              name={`q-${question.questionId}`}
              value={option.optionId}
              checked={selected === option.optionId}
              disabled={locked}
              onChange={() => void choose(option.optionId)}
            />
            <span>{option.text}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <span className={`autosave ${selected !== null && !saving ? 'saved' : ''}`}>
          {saving ? 'Saving…' : selected !== null ? 'Saved on this computer' : 'Not answered yet'}
        </span>
        {selected !== null && !locked ? (
          <button type="button" className="btn ghost small" onClick={() => void choose(null)}>
            Clear my answer
          </button>
        ) : null}
      </div>
    </>
  );
}

// ── Written ─────────────────────────────────────────────────────────────────

function WrittenInput({
  attemptKey,
  question,
  answer,
  locked,
  onAnswerChanged,
}: {
  attemptKey: AttemptKey;
  question: Question;
  answer: AnswerRecord | null;
  locked: boolean;
  onAnswerChanged: () => void;
}): JSX.Element {
  const service = useService();
  const maxChars = question.maxChars ?? 4000;
  const [text, setText] = useState(answer?.text ?? '');
  const lastLoaded = useRef(answer?.revision ?? 0);

  // Re-sync only when the stored answer changed underneath us (e.g. after a reload),
  // never while the student is typing.
  useEffect(() => {
    const revision = answer?.revision ?? 0;
    if (revision !== lastLoaded.current) {
      lastLoaded.current = revision;
      setText(answer?.text ?? '');
    }
  }, [answer]);

  const autosave = useAutosave<string>(async (value) => {
    const ok = await service.saveText(attemptKey, question.questionId, value);
    onAnswerChanged();
    return ok;
  });

  return (
    <>
      <div className="field">
        <label htmlFor={`q-${question.questionId}`} className="sr-only">
          Your answer to question {question.number}
        </label>
        <textarea
          id={`q-${question.questionId}`}
          value={text}
          maxLength={maxChars}
          disabled={locked}
          spellCheck={false}
          placeholder={locked ? '' : 'Type your answer here…'}
          onChange={(event) => {
            setText(event.target.value);
            autosave.push(event.target.value);
          }}
          onBlur={() => void autosave.flush()}
        />
      </div>
      <div className="row between">
        <span className={`autosave ${autosave.state === 'saved' ? 'saved' : ''}`}>
          {autosave.state === 'pending'
            ? 'Saving…'
            : autosave.state === 'saved'
              ? 'Saved on this computer'
              : autosave.state === 'error'
                ? 'Could not save — tell the invigilator'
                : text
                  ? 'Saved on this computer'
                  : 'Not answered yet'}
        </span>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {text.length} / {maxChars}
        </span>
      </div>
    </>
  );
}

// ── Upload ──────────────────────────────────────────────────────────────────

function UploadInput({
  attemptKey,
  question,
  files,
  rules,
  locked,
  onAnswerChanged,
}: {
  attemptKey: AttemptKey;
  question: Question;
  answer: AnswerRecord | null;
  files: StoredFileMeta[];
  rules: AttachmentRules;
  locked: boolean;
  onAnswerChanged: () => void;
}): JSX.Element {
  const service = useService();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useMemo(() => rules.allowedMime.join(','), [rules.allowedMime]);
  const full = files.length >= rules.maxFilesPerQuestion;

  const add = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setBusy(true);
      setError(null);
      for (const file of Array.from(fileList)) {
        const result = await service.addAnswerFile(attemptKey, question.questionId, file);
        if (!result.ok) {
          setError(result.reason);
          break;
        }
      }
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
      onAnswerChanged();
    },
    [attemptKey, onAnswerChanged, question.questionId, service],
  );

  const remove = useCallback(
    async (fileId: string) => {
      setBusy(true);
      await service.removeAnswerFile(attemptKey, question.questionId, fileId);
      setBusy(false);
      onAnswerChanged();
    },
    [attemptKey, onAnswerChanged, question.questionId, service],
  );

  return (
    <div className="stack tight">
      {!rules.enabled ? (
        <Banner tone="warn">This exam does not accept attachments.</Banner>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`file-${question.questionId}`}>
              Attach your answer ({files.length} of {rules.maxFilesPerQuestion})
            </label>
            <input
              id={`file-${question.questionId}`}
              ref={inputRef}
              type="file"
              accept={accept}
              multiple={rules.maxFilesPerQuestion > 1}
              capture="environment"
              disabled={locked || full || busy}
              onChange={(event) => void add(event.target.files)}
            />
            <span className="help">
              {rules.allowedMime.join(', ')} · up to {formatBytes(rules.maxFileBytes)} each. Files
              stay on this computer until the internet is back.
            </span>
          </div>

          {error ? <Banner tone="danger">{error}</Banner> : null}

          <div className="attachments">
            {files.map((file) => (
              <AttachmentRow
                key={file.fileId}
                file={file}
                locked={locked || busy}
                onRemove={() => void remove(file.fileId)}
              />
            ))}
            {files.length === 0 ? <span className="muted">Nothing attached yet.</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

function AttachmentRow({
  file,
  locked,
  onRemove,
}: {
  file: StoredFileMeta;
  locked: boolean;
  onRemove: () => void;
}): JSX.Element {
  const isImage = file.mimeType.startsWith('image/');
  return (
    <div className="attachment">
      {isImage ? <LocalImage fileId={file.fileId} alt={file.name} thumb /> : <span aria-hidden="true">📄</span>}
      <span className="name">
        {file.name}
        <br />
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {formatBytes(file.size)} · saved on this computer
        </span>
      </span>
      {!locked ? (
        <button type="button" className="btn secondary small" onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

/**
 * Renders an image out of the local file store. Object URLs are revoked on unmount so a
 * long exam with many pictures does not leak memory on a lab machine.
 */
export function LocalImage({
  fileId,
  alt,
  thumb,
}: {
  fileId: string;
  alt: string;
  thumb?: boolean;
}): JSX.Element | null {
  const service = useService();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    void service.fileUrl(fileId).then((next) => {
      if (revoked) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      created = next;
      setUrl(next);
    });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [fileId, service]);

  if (!url) return null;
  return <img src={url} alt={alt} style={thumb ? undefined : { maxWidth: '100%' }} />;
}
