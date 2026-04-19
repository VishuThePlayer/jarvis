import { useEffect, useRef, useCallback, useState } from "react";

export function useAutoScroll<T extends HTMLElement>(dep: number) {
  const ref = useRef<T>(null);
  const userScrolledUp = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const threshold = 100;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > threshold;
    setIsAtBottom(distanceFromBottom <= threshold);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    userScrolledUp.current = false;
    setIsAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const el = ref.current;
    if (!el || userScrolledUp.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [dep]);

  return { ref, isAtBottom, scrollToBottom };
}
