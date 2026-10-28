import { useEffect, useState } from 'react';

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof matchMedia !== 'undefined' ? matchMedia(query).matches : false));
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}
