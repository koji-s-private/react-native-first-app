import { render, screen } from '@testing-library/react-native';
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

import ModalScreen from '@/app/modal';

describe('ModalScreen', () => {
  it('renders the modal title', () => {
    render(<ModalScreen />);

    expect(screen.getByText('This is a modal')).toBeTruthy();
  });

  it('renders instructions for closing the modal', () => {
    render(<ModalScreen />);

    expect(
      screen.getByText(
        "Use your device's back gesture or button, or tap the link below to close this modal."
      )
    ).toBeTruthy();
  });

  it('renders the link to go back to the home screen', () => {
    render(<ModalScreen />);

    expect(screen.getByText('Go to home screen')).toBeTruthy();
  });
});
