import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

// `expo-router`'s `Link` (with its `Trigger`/`Preview`/`Menu` compound API) requires a
// navigation/router context that isn't set up when rendering the screen in isolation.
// We stub it out with simple pass-through components so the screen's own content can be
// asserted without pulling in the whole router.
jest.mock('expo-router', () => {
  const PassThrough = ({ children }: PropsWithChildren) => children;

  const Link = PassThrough as unknown as typeof PassThrough & {
    Trigger: typeof PassThrough;
    Preview: () => null;
    Menu: typeof PassThrough;
    MenuAction: () => null;
  };
  function LinkPreview() {
    return null;
  }

  function LinkMenuAction() {
    return null;
  }

  Link.Trigger = PassThrough;
  Link.Preview = LinkPreview;
  Link.Menu = PassThrough;
  Link.MenuAction = LinkMenuAction;

  return { Link };
});

// The native `AsyncStorage` module isn't available in the Jest environment
// (`NativeModule: AsyncStorage is null`), so we swap in the official in-memory mock
// shipped with the package. This lets the screen's persistence logic (`getItem`/`setItem`)
// run against a real (fake) storage backend instead of crashing.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import HomeScreen from '@/app/(tabs)/index';

const STORAGE_KEY = 'diary-entries';
const INPUT_PLACEHOLDER = '今日の出来事や気持ちを書いてみましょう';
const EMPTY_STATE_MESSAGE = 'まだ日記がありません。最初の日記を書いてみましょう。';

describe('HomeScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('renders the diary title', async () => {
    render(<HomeScreen />);

    expect(screen.getByText('日記')).toBeTruthy();

    // Let the initial `AsyncStorage.getItem` effect settle so it doesn't leak into
    // the next test.
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  });

  it('shows the empty state message when there are no stored entries', async () => {
    render(<HomeScreen />);

    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
    expect(screen.getByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
  });

  it('restores previously saved entries from AsyncStorage on mount', async () => {
    const storedEntries = [
      { id: '1', text: '2件目の日記', createdAt: '2024-01-02T00:00:00.000Z' },
      { id: '2', text: '1件目の日記', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
    jest.clearAllMocks();

    render(<HomeScreen />);

    expect(await screen.findByText('2件目の日記')).toBeTruthy();
    expect(screen.getByText('1件目の日記')).toBeTruthy();
    expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
  });

  it('saves a new entry, persists it to AsyncStorage, and shows it at the top of the list', async () => {
    const storedEntries = [
      { id: 'old', text: '過去の日記', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
    jest.clearAllMocks();

    render(<HomeScreen />);
    await screen.findByText('過去の日記');

    fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
    fireEvent.press(screen.getByText('保存'));

    expect(await screen.findByText('今日の日記')).toBeTruthy();
    expect(screen.getByText('過去の日記')).toBeTruthy();

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
    const [key, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
    expect(key).toBe(STORAGE_KEY);

    const persisted = JSON.parse(value);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].text).toBe('今日の日記');
    expect(persisted[1].text).toBe('過去の日記');
  });

  it('clears the text input after saving', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    fireEvent.changeText(input, '入力内容');
    fireEvent.press(screen.getByText('保存'));

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
    expect(input.props.value).toBe('');
  });

  it('does not save and does not call AsyncStorage.setItem when the input is empty', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    fireEvent.press(screen.getByText('保存'));

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(screen.getByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
  });

  it('does not save an entry consisting only of whitespace', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');
    fireEvent.press(screen.getByText('保存'));

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(screen.getByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
  });

  it('disables the save button while the input is empty and enables it once text is entered', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    // `getByText('保存')` resolves the innermost `Text` node; the rendered `Pressable`
    // (which carries the `disabled` prop as `accessibilityState.disabled`) is three
    // levels up in the tree (Text -> Text -> ThemedText -> Pressable's host View).
    const saveButton = screen.getByText('保存').parent?.parent?.parent;
    expect(saveButton?.props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '何か書く');

    expect(saveButton?.props.accessibilityState?.disabled).toBe(false);
  });
});
