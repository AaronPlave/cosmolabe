import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Component } from 'svelte';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Types expected by shadcn-svelte generated components
export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & { ref?: El | null };
export type WithoutChildren<T> = T & { children?: never };
export type WithoutChildrenOrChild<T> = T & { children?: never; child?: never };
