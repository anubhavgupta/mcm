import { z } from 'zod';

export const themeIds = [
  'dark-plus', 'light-plus', 'dracula', 'one-dark-pro', 'github-dark',
  'github-light', 'nord', 'tokyo-night', 'solarized-dark', 'monokai',
] as const;
export type ThemeId = typeof themeIds[number];
export const defaultTheme: ThemeId = 'light-plus';
export const themeSchema = z.enum(themeIds).default(defaultTheme);

export interface ThemePalette {
  canvas: string;
  surface: string;
  editor: string;
  sidebar: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  special: string;
}
export interface BuiltInTheme {
  id: ThemeId;
  name: string;
  colorScheme: 'light' | 'dark';
  colors: ThemePalette;
}

// Original MCM semantic palettes inspired by familiar editor themes, not extension assets.
export const themes: readonly BuiltInTheme[] = [
  {
    id: 'dark-plus', name: 'Dark+', colorScheme: 'dark',
    colors: {
      canvas: '#181818', surface: '#252526', editor: '#1e1e1e', sidebar: '#202020',
      text: '#dedede', muted: '#a6a6aa', border: '#48484b', accent: '#63b3f4', onAccent: '#102538',
      success: '#89c88d', warning: '#e3bd78', danger: '#f18d87', info: '#85c6e8', special: '#c7a5e5',
    },
  },
  {
    id: 'light-plus', name: 'Light+', colorScheme: 'light',
    colors: {
      canvas: '#f4f6f8', surface: '#ffffff', editor: '#f8fafc', sidebar: '#e9edf2',
      text: '#243142', muted: '#586779', border: '#cbd3de', accent: '#0969b5', onAccent: '#ffffff',
      success: '#267343', warning: '#8b5a12', danger: '#b43737', info: '#22689c', special: '#7951a1',
    },
  },
  {
    id: 'dracula', name: 'Dracula', colorScheme: 'dark',
    colors: {
      canvas: '#232430', surface: '#2d2e3e', editor: '#272834', sidebar: '#20212d',
      text: '#f2eff8', muted: '#b6b1ce', border: '#535369', accent: '#c3a1f2', onAccent: '#292037',
      success: '#8ae8a3', warning: '#f0d98a', danger: '#ff939e', info: '#93dce6', special: '#eda9d9',
    },
  },
  {
    id: 'one-dark-pro', name: 'One Dark Pro', colorScheme: 'dark',
    colors: {
      canvas: '#242830', surface: '#2e333d', editor: '#282c34', sidebar: '#21252c',
      text: '#dce1e9', muted: '#aab3c2', border: '#4d5665', accent: '#79b9ed', onAccent: '#182b3b',
      success: '#a4ca87', warning: '#e5bf87', danger: '#ec959f', info: '#80c9d2', special: '#cda1e6',
    },
  },
  {
    id: 'github-dark', name: 'GitHub Dark', colorScheme: 'dark',
    colors: {
      canvas: '#0d1117', surface: '#161b22', editor: '#10161e', sidebar: '#090e14',
      text: '#e0e6ed', muted: '#a1adbc', border: '#364352', accent: '#70b7ff', onAccent: '#10263c',
      success: '#7cce96', warning: '#e4bd70', danger: '#fa9291', info: '#8acbfa', special: '#c3a5f5',
    },
  },
  {
    id: 'github-light', name: 'GitHub Light', colorScheme: 'light',
    colors: {
      canvas: '#f6f8fa', surface: '#ffffff', editor: '#f0f3f6', sidebar: '#edf1f5',
      text: '#24292f', muted: '#576574', border: '#c6cfd8', accent: '#0969da', onAccent: '#ffffff',
      success: '#21753b', warning: '#895b0d', danger: '#bd3039', info: '#096c8e', special: '#8250b0',
    },
  },
  {
    id: 'nord', name: 'Nord', colorScheme: 'dark',
    colors: {
      canvas: '#2b3240', surface: '#353e4f', editor: '#2e3645', sidebar: '#272e3b',
      text: '#e7edf4', muted: '#b2c0d2', border: '#536279', accent: '#91c6d1', onAccent: '#21333c',
      success: '#b3cd9b', warning: '#edcf99', danger: '#e5a0a9', info: '#a6c9e9', special: '#ccb2d3',
    },
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night', colorScheme: 'dark',
    colors: {
      canvas: '#181a29', surface: '#23263b', editor: '#1d2032', sidebar: '#141624',
      text: '#d1dbfa', muted: '#a0acd2', border: '#444e70', accent: '#8baeff', onAccent: '#1c2847',
      success: '#aedc93', warning: '#ebcc8c', danger: '#ff96b2', info: '#8bd9ed', special: '#c2a6ff',
    },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', colorScheme: 'dark',
    colors: {
      canvas: '#002b36', surface: '#093945', editor: '#03303b', sidebar: '#002630',
      text: '#d2e0db', muted: '#9cb7b8', border: '#3a626a', accent: '#78c0d0', onAccent: '#052c36',
      success: '#b7cb79', warning: '#e2c06f', danger: '#f09c8a', info: '#8ec0e2', special: '#c8abe2',
    },
  },
  {
    id: 'monokai', name: 'Monokai', colorScheme: 'dark',
    colors: {
      canvas: '#24251f', surface: '#303129', editor: '#282922', sidebar: '#1e201a',
      text: '#f0f0e3', muted: '#b8bb9f', border: '#575a48', accent: '#b6d979', onAccent: '#253019',
      success: '#b8db82', warning: '#eadb8b', danger: '#ff97af', info: '#8dd9e1', special: '#c8aff4',
    },
  },
];

export function getTheme(id: ThemeId): BuiltInTheme {
  return themes.find(theme => theme.id === id)!;
}
