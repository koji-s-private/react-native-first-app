import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { SegmentedOptionSelector } from '@/components/segmented-option-selector';

const OPTIONS = [
  { value: 'a', label: '選択肢A' },
  { value: 'b', label: '選択肢B' },
  { value: 'c', label: '選択肢C' },
];

describe('SegmentedOptionSelector', () => {
  it('renders all given options', () => {
    render(<SegmentedOptionSelector options={OPTIONS} selectedValue="a" onChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: '選択肢A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '選択肢B' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '選択肢C' })).toBeTruthy();
  });

  it('marks the currently selected option with accessibilityState.selected=true', () => {
    render(<SegmentedOptionSelector options={OPTIONS} selectedValue="b" onChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: '選択肢B' }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole('button', { name: '選択肢A' }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(screen.getByRole('button', { name: '選択肢C' }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('calls onChange with the pressed option value when an unselected option is pressed', () => {
    const onChange = jest.fn();
    render(<SegmentedOptionSelector options={OPTIONS} selectedValue="a" onChange={onChange} />);

    fireEvent.press(screen.getByRole('button', { name: '選択肢C' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('calls onChange even when the already-selected option is pressed again (呼び出し元でのハンドリングに委ねる)', () => {
    const onChange = jest.fn();
    render(<SegmentedOptionSelector options={OPTIONS} selectedValue="a" onChange={onChange} />);

    fireEvent.press(screen.getByRole('button', { name: '選択肢A' }));

    expect(onChange).toHaveBeenCalledWith('a');
  });
});
