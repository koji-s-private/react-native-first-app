import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode } from 'react';

import { DiaryEntryComposerModal } from '@/components/diary-entry-composer-modal';
import { type SaveDiaryEntryOptions, useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { loadDraftText, saveDraftText } from '@/utils/diary-draft-storage';

jest.mock('@/hooks/use-modal-slide-transition', () => ({
  useModalSlideTransition: () => ({
    isMounted: true,
    overlayOpacity: 1,
    contentTranslateY: 0,
  }),
}));

jest.mock('@/utils/diary-draft-storage', () => ({
  loadDraftText: jest.fn(),
  saveDraftText: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/hooks/use-save-diary-entry', () => ({
  useSaveDiaryEntry: jest.fn(),
}));

const loadDraftTextMock = jest.mocked(loadDraftText);
const saveDraftTextMock = jest.mocked(saveDraftText);
const useSaveDiaryEntryMock = jest.mocked(useSaveDiaryEntry);
const saveEntryMock = jest.fn(async (_options: SaveDiaryEntryOptions) => {});
const setErrorMock = jest.fn();

const defaultProps = {
  dateKey: '2026-09-19',
  draftStorageKeyPrefix: 'test-draft-',
  contentBottomPadding: 0,
  persist: jest.fn(() => Promise.resolve()),
  onSaved: jest.fn(),
  onClose: jest.fn(),
};

describe('DiaryEntryComposerModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadDraftTextMock.mockResolvedValue(null);
    saveDraftTextMock.mockResolvedValue(undefined);
    saveEntryMock.mockResolvedValue(undefined);
    useSaveDiaryEntryMock.mockReturnValue({
      isSaving: false,
      error: null,
      setError: setErrorMock,
      save: saveEntryMock,
    });
  });

  it('restores the saved draft when the user has not edited the input while loading', async () => {
    loadDraftTextMock.mockResolvedValueOnce('保存されていた下書き');

    render(<DiaryEntryComposerModal {...defaultProps} />);

    await waitFor(() =>
      expect(screen.getByLabelText('日記本文').props.value).toBe('保存されていた下書き'),
    );
    expect(loadDraftTextMock).toHaveBeenCalledWith('test-draft-2026-09-19');
  });

  it('keeps text entered before draft restoration finishes instead of overwriting it', async () => {
    let resolveLoad: (value: string | null) => void = () => {};
    loadDraftTextMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(<DiaryEntryComposerModal {...defaultProps} />);
    fireEvent.changeText(screen.getByLabelText('日記本文'), '読み込み中に入力した本文');

    await act(async () => {
      resolveLoad('古い下書き');
    });

    expect(screen.getByLabelText('日記本文').props.value).toBe('読み込み中に入力した本文');
  });

  it('passes a mounted ref to the save flow after StrictMode replays effects', async () => {
    render(
      <StrictMode>
        <DiaryEntryComposerModal {...defaultProps} />
      </StrictMode>,
    );
    await waitFor(() => expect(loadDraftTextMock).toHaveBeenCalled());

    fireEvent.changeText(screen.getByLabelText('日記本文'), '保存する本文');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(saveEntryMock).toHaveBeenCalledTimes(1));
    expect(saveEntryMock.mock.calls[0][0].isMountedRef?.current).toBe(true);
  });
});
