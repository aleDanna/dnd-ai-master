'use client';
import * as React from 'react';

const DEFAULT_QUERY = '(max-width: 720px)';

export function useIsMobile(query: string = DEFAULT_QUERY): boolean {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const update = (): void => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return isMobile;
}
