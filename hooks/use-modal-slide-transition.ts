import { useEffect, useRef, useState } from 'react';
import { Animated, useWindowDimensions } from 'react-native';

// モーダルのフェード・スライドアニメーション時間(ミリ秒)
const MODAL_ANIMATION_DURATION_MS = 220;

// 背景オーバーレイのフェードとコンテンツのスライドを分離アニメーションさせるフック
// (`Modal`のanimationTypeは'none'にし、返り値のAnimated.Valueを呼び出し側でstyleに適用する)。
// `isOpen`がfalseになった瞬間に`visible`もfalseにすると退場アニメーションが再生されないため、
// 実際に描画するかどうかを表す`isMounted`を別stateで持ち、退場アニメーション完了後にfalseへ戻す
export function useModalSlideTransition(isOpen: boolean) {
  const { height: windowHeight } = useWindowDimensions();
  const [isMounted, setIsMounted] = useState(isOpen);
  const overlayOpacity = useRef(new Animated.Value(isOpen ? 1 : 0)).current;
  const contentTranslateY = useRef(new Animated.Value(isOpen ? 0 : windowHeight)).current;

  useEffect(() => {
    if (isOpen) {
      // 入場アニメーション再生前に描画状態にする(退場時は完了後にfalseへ戻す)
      setIsMounted(true);
    }
    // opacity/transformはuseNativeDriver対象にでき、UIスレッド側で進行するためJSスレッド混雑の影響を受けにくい
    const animation = Animated.parallel([
      Animated.timing(overlayOpacity, {
        toValue: isOpen ? 1 : 0,
        duration: MODAL_ANIMATION_DURATION_MS,
        useNativeDriver: true,
      }),
      Animated.timing(contentTranslateY, {
        toValue: isOpen ? 0 : windowHeight,
        duration: MODAL_ANIMATION_DURATION_MS,
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      // 中断された場合はfinished===falseになるため、後から開始した最新のアニメーション側に任せる
      if (finished && !isOpen) {
        setIsMounted(false);
      }
    });
    return () => animation.stop();
  }, [isOpen, overlayOpacity, contentTranslateY, windowHeight]);

  return { isMounted, overlayOpacity, contentTranslateY };
}
