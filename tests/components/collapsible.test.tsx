import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { Collapsible } from '@/components/ui/collapsible';

describe('Collapsible', () => {
  it('renders the title and hides the children by default (closed state)', () => {
    render(
      <Collapsible title="詳細">
        <Text>隠れた内容</Text>
      </Collapsible>,
    );

    expect(screen.getByText('詳細')).toBeTruthy();
    expect(screen.queryByText('隠れた内容')).toBeNull();
  });

  it('shows the children after pressing the heading once (opens)', () => {
    render(
      <Collapsible title="詳細">
        <Text>隠れた内容</Text>
      </Collapsible>,
    );

    fireEvent.press(screen.getByText('詳細'));

    expect(screen.getByText('隠れた内容')).toBeTruthy();
  });

  it('hides the children again after pressing the heading twice (toggles back to closed)', () => {
    render(
      <Collapsible title="詳細">
        <Text>隠れた内容</Text>
      </Collapsible>,
    );

    fireEvent.press(screen.getByText('詳細'));
    fireEvent.press(screen.getByText('詳細'));

    expect(screen.queryByText('隠れた内容')).toBeNull();
  });

  it('keeps independent open/close state across multiple presses (opens, closes, opens again)', () => {
    render(
      <Collapsible title="詳細">
        <Text>隠れた内容</Text>
      </Collapsible>,
    );

    const heading = screen.getByText('詳細');

    fireEvent.press(heading);
    expect(screen.getByText('隠れた内容')).toBeTruthy();

    fireEvent.press(heading);
    expect(screen.queryByText('隠れた内容')).toBeNull();

    fireEvent.press(heading);
    expect(screen.getByText('隠れた内容')).toBeTruthy();
  });
});
