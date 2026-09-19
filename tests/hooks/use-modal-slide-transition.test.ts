import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Animated, Dimensions } from 'react-native';

import { useModalSlideTransition } from '@/hooks/use-modal-slide-transition';

describe('useModalSlideTransition', () => {
  const originalWindow = Dimensions.get('window');

  afterEach(async () => {
    await act(async () => {
      Dimensions.set({ window: originalWindow, screen: originalWindow });
    });
    jest.restoreAllMocks();
  });

  it('mounts immediately (isMounted=true) when isOpen is initially true (正常系: 初期表示)', () => {
    const { result } = renderHook(() => useModalSlideTransition(true));

    expect(result.current.isMounted).toBe(true);
  });

  it('does not mount (isMounted=false) when isOpen is initially false (正常系: 初期非表示)', () => {
    const { result } = renderHook(() => useModalSlideTransition(false));

    expect(result.current.isMounted).toBe(false);
  });

  it('mounts (isMounted=true) once isOpen changes from false to true (正常系: 入場)', async () => {
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => useModalSlideTransition(isOpen),
      { initialProps: { isOpen: false } },
    );
    expect(result.current.isMounted).toBe(false);

    act(() => {
      rerender({ isOpen: true });
    });

    await waitFor(() => expect(result.current.isMounted).toBe(true));
  });

  it('unmounts (isMounted=false) once the exit animation completes after isOpen changes to true→false (正常系: 退場)', async () => {
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => useModalSlideTransition(isOpen),
      { initialProps: { isOpen: true } },
    );
    expect(result.current.isMounted).toBe(true);

    act(() => {
      rerender({ isOpen: false });
    });

    await waitFor(() => expect(result.current.isMounted).toBe(false));
  });

  it('remains mounted (isMounted=true) when isOpen flips back to true shortly after flipping to false (中断された退場からの再入場: 回帰確認)', async () => {
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => useModalSlideTransition(isOpen),
      { initialProps: { isOpen: true } },
    );

    act(() => {
      rerender({ isOpen: false });
    });
    act(() => {
      rerender({ isOpen: true });
    });

    // 退場・再入場のどちらの経路を通っても、最終的にisOpen=trueである以上マウントされたままになる
    await waitFor(() => expect(result.current.isMounted).toBe(true));
    // 猶予をおいても、退場アニメーション完了によって誤ってfalseへ戻らないことを確認する
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(result.current.isMounted).toBe(true);
  });

  it('uses the current window height as the exit distance after the window is resized', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');
    const { rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => useModalSlideTransition(isOpen),
      { initialProps: { isOpen: true } },
    );

    await act(async () => {
      const resizedWindow = { ...originalWindow, height: 1200 };
      Dimensions.set({ window: resizedWindow, screen: resizedWindow });
    });
    timingSpy.mockClear();

    act(() => {
      rerender({ isOpen: false });
    });

    expect(timingSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 1200 }),
    );
  });
});
