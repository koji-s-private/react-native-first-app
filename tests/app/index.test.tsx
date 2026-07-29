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

import HomeScreen from '@/app/(tabs)/index';

describe('HomeScreen', () => {
  it('renders the welcome title', () => {
    render(<HomeScreen />);

    expect(screen.getByText('Welcome!')).toBeTruthy();
  });

  it('renders the introductory text below the welcome title', () => {
    render(<HomeScreen />);

    expect(
      screen.getByText(
        'This is a starter app built with Expo and React Native. Follow the steps below to start customizing it.'
      )
    ).toBeTruthy();
  });

  it('still renders the step-by-step guidance headings', () => {
    render(<HomeScreen />);

    expect(screen.getByText('Step 1: Try it')).toBeTruthy();
    expect(screen.getByText('Step 2: Explore')).toBeTruthy();
    expect(screen.getByText('Step 3: Get a fresh start')).toBeTruthy();
  });
});
