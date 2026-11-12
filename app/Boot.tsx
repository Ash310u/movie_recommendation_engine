'use client';

import { useEffect } from 'react';

/**
 * Starts the map once the page's markup is on screen. It is plain TypeScript that finds its
 * elements by id, so React only renders the markup and never re-renders it. A module runs once
 * however often this effect does (e.g. twice in dev's Strict Mode). From mov/app/Boot.tsx.
 */
export function Boot() {
  useEffect(() => {
    void import('../components/map/main');
  }, []);
  return null;
}
