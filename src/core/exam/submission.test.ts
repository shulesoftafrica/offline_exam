import { describe, expect, it } from 'vitest';
import type { AnswerRecord, StoredFileMeta } from '../../types';
import { buildSubmissionPayload } from './submission';
import { groupQuestions, isQuestionGroup, flattenQuestions } from './bundle';
import type { Question } from '../../types';

/**
 * The payload is what the server marks and what the checksum covers, so its shape must be
 * deterministic regardless of the order the student answered in.
 */

function answer(partial: Partial<AnswerRecord> & { questionId: number }): AnswerRecord {
  return {
    id: `k::${partial.questionId}`,
    attemptKey: 'k',
    kind: 'written',
    optionId: null,
    text: null,
    fileIds: [],
    updatedAt: 0,
    revision: 1,
    ...partial,
  };
}

function file(partial: Partial<StoredFileMeta> & { fileId: string; sha256: string }): StoredFileMeta {
  return {
    attemptKey: 'k',
    questionId: 7787,
    role: 'answer',
    name: 'graph.png',
    mimeType: 'image/png',
    size: 1234,
    storage: 'idb',
    path: null,
    createdAt: 0,
    uploadState: 'local',
    serverPath: null,
    ...partial,
  };
}

function question(partial: Partial<Question> & { questionId: number; number: string }): Question {
  return {
    kind: 'written',
    text: 't',
    weight: 1,
    imageUrl: null,
    options: [],
    maxChars: null,
    inputHint: null,
    groupRef: null,
    partLabel: null,
    ...partial,
  };
}

describe('submission payload', () => {
  it('sorts answers by question id and drops empty values', async () => {
    const payload = await buildSubmissionPayload(
      [
        answer({ questionId: 7783, text: 'later question' }),
        answer({ questionId: 7781, kind: 'choice', optionId: 55012 }),
        answer({ questionId: 7782, text: '   ' }),
      ],
      new Map(),
    );

    expect(payload.answers.map((a) => a.questionId)).toEqual([7781, 7782, 7783]);
    expect(payload.answers[0]?.optionId).toBe(55012);
    expect(payload.answers[1]?.text).toBeUndefined(); // whitespace is not an answer
    expect(payload.answeredCount).toBe(3);
  });

  it('produces the same checksum whatever order the answers arrive in', async () => {
    const a = answer({ questionId: 1, text: 'one' });
    const b = answer({ questionId: 2, kind: 'choice', optionId: 9 });

    const one = await buildSubmissionPayload([a, b], new Map());
    const other = await buildSubmissionPayload([b, a], new Map());

    expect(one.answerChecksum).toBe(other.answerChecksum);
  });

  it('changes the checksum when an answer changes', async () => {
    const before = await buildSubmissionPayload([answer({ questionId: 1, text: 'one' })], new Map());
    const after = await buildSubmissionPayload([answer({ questionId: 1, text: 'two' })], new Map());

    expect(before.answerChecksum).not.toBe(after.answerChecksum);
  });

  it('builds an attachment manifest and maps digests back to local files', async () => {
    const f1 = file({ fileId: 'file-1', sha256: 'bbb' });
    const f2 = file({ fileId: 'file-2', sha256: 'aaa' });

    const payload = await buildSubmissionPayload(
      [answer({ questionId: 7787, kind: 'upload', fileIds: ['file-1', 'file-2'] })],
      new Map([[7787, [f1, f2]]]),
    );

    // Sorted by digest, so a retry sends them in the same order.
    expect(payload.attachmentManifest.map((m) => m.sha256)).toEqual(['aaa', 'bbb']);
    expect(payload.answers[0]?.attachments).toHaveLength(2);
    expect(payload.fileIdsByDigest).toEqual({ aaa: 'file-2', bbb: 'file-1' });
  });

  it('ignores files that are not attached to the answer and media files', async () => {
    const attached = file({ fileId: 'file-1', sha256: 'aaa' });
    const detached = file({ fileId: 'file-2', sha256: 'bbb' });
    const media = file({ fileId: 'file-3', sha256: 'ccc', role: 'media' });

    const payload = await buildSubmissionPayload(
      [answer({ questionId: 7787, kind: 'upload', fileIds: ['file-1'] })],
      new Map([[7787, [attached, detached, media]]]),
    );

    expect(payload.attachmentManifest.map((m) => m.sha256)).toEqual(['aaa']);
  });
});

describe('structured questions', () => {
  it('groups consecutive parts and keeps each part its own question', () => {
    const items = groupQuestions([
      question({ questionId: 1, number: '1' }),
      question({ questionId: 2, number: '2a', groupRef: 'q2', partLabel: '(a)' }),
      question({ questionId: 3, number: '2b', groupRef: 'q2', partLabel: '(b)' }),
      question({ questionId: 4, number: '3' }),
    ]);

    expect(items).toHaveLength(3);
    const group = items[1];
    expect(group && isQuestionGroup(group)).toBe(true);
    if (group && isQuestionGroup(group)) {
      expect(group.parts.map((p) => p.questionId)).toEqual([2, 3]);
    }
    expect(flattenQuestions(items).map((q) => q.questionId)).toEqual([1, 2, 3, 4]);
  });

  it('starts a new group when the group ref changes', () => {
    const items = groupQuestions([
      question({ questionId: 1, number: '1a', groupRef: 'q1' }),
      question({ questionId: 2, number: '2a', groupRef: 'q2' }),
    ]);
    expect(items).toHaveLength(2);
  });
});
