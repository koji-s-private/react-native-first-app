import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

import appConfig from '@/app.json';
import ExploreScreen from '@/app/(tabs)/explore';

// `ExternalLink` (used inside some of the Collapsible sections on this screen) wraps
// `expo-router`'s `Link`, which requires a navigation/router context that isn't set up
// when rendering the screen in isolation. We stub it out the same way
// `tests/app/index.test.tsx` does, so the screen's own content can be asserted without
// pulling in the whole router.
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

// In the real app, Expo's tooling populates `Constants.expoConfig` from `app.json` at
// build/runtime. The `jest-expo` test environment has no bundler-injected manifest though,
// so `Constants.expoConfig` is `undefined` by default and there is nothing for the screen
// to render. We mock `expo-constants` here so `expoConfig` is sourced directly from
// `app.json` (the same file the test asserts against below), faithfully reproducing the
// real relationship between `app.json` and `Constants.expoConfig` without hardcoding a
// version string anywhere in this test file.
jest.mock('expo-constants', () => {
  const config = require('../../app.json');

  return {
    __esModule: true,
    default: {
      expoConfig: { version: config.expo.version },
    },
  };
});

describe('ExploreScreen', () => {
  it('renders the Explore title', () => {
    render(<ExploreScreen />);

    expect(screen.getByText('Explore')).toBeTruthy();
  });

  it('renders an "App version" section', () => {
    render(<ExploreScreen />);

    expect(screen.getByText('App version')).toBeTruthy();
  });

  it("reveals the app.json expo.version value when the 'App version' section is expanded", () => {
    render(<ExploreScreen />);

    // The section's body text isn't rendered until the Collapsible is toggled open.
    fireEvent.press(screen.getByText('App version'));

    // Assert against the value read from app.json rather than a hardcoded string, so this
    // test keeps passing (and failing appropriately) as the app is versioned over time.
    const expectedVersion = appConfig.expo.version;
    expect(typeof expectedVersion).toBe('string');
    expect(expectedVersion.length).toBeGreaterThan(0);

    expect(screen.getByText(expectedVersion)).toBeTruthy();
    expect(screen.getByText('expo.version')).toBeTruthy();
    expect(screen.getByText('app.json')).toBeTruthy();
  });
});
