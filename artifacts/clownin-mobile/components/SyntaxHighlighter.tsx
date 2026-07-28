/**
 * Lightweight syntax highlighter for JavaScript and Python.
 * Pure JS — no native modules, fully compatible with Expo Go.
 *
 * Renders tokenised code as styled <Text> spans inside a ScrollView.
 * Tap the view to enter edit mode (parent controls this via onPress).
 */
import React, { memo } from 'react';
import { ScrollView, Text, View, StyleSheet, Pressable, Platform } from 'react-native';

// ─── Token types ──────────────────────────────────────────────────────────────
type TokenType =
  | 'keyword'
  | 'builtin'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'operator'
  | 'plain';

interface Token {
  type: TokenType;
  value: string;
}

// ─── Theme colours (GitHub Dark palette, matches #0d1117 background) ──────────
export const syntaxColors: Record<TokenType, string> = {
  keyword:  '#ff7b72',  // red-orange  — if, for, function, def …
  builtin:  '#ffa657',  // amber       — console, print, True, None …
  string:   '#a5d6ff',  // sky blue    — "hello", 'world', `template`
  comment:  '#6e7681',  // grey        — // … , # …
  number:   '#79c0ff',  // blue        — 42, 3.14
  function: '#d2a8ff',  // purple      — foo(   myFn(
  operator: '#ff7b72',  // same red    — = + - * / === …
  plain:    '#e6edf3',  // foreground  — everything else
};

// ─── Keyword sets ─────────────────────────────────────────────────────────────
const JS_KEYWORDS = new Set([
  'break','case','catch','class','const','continue','debugger','default',
  'delete','do','else','export','extends','finally','for','function','if',
  'import','in','instanceof','let','new','of','return','static','super',
  'switch','this','throw','try','typeof','var','void','while','with','yield',
  'async','await','from','as','abstract','interface','type','enum',
]);

const JS_BUILTINS = new Set([
  'console','Math','JSON','Object','Array','String','Number','Boolean',
  'Promise','Error','undefined','null','true','false','NaN','Infinity',
  'parseInt','parseFloat','isNaN','isFinite','encodeURI','decodeURI',
  'setTimeout','setInterval','clearTimeout','clearInterval',
  'require','module','exports','process','global','window','document',
]);

const PY_KEYWORDS = new Set([
  'False','None','True','and','as','assert','async','await','break','class',
  'continue','def','del','elif','else','except','finally','for','from',
  'global','if','import','in','is','lambda','nonlocal','not','or','pass',
  'raise','return','try','while','with','yield',
]);

const PY_BUILTINS = new Set([
  'print','input','len','range','type','int','str','float','bool','list',
  'dict','set','tuple','open','sum','max','min','abs','round','sorted',
  'reversed','enumerate','zip','map','filter','any','all','hasattr',
  'getattr','setattr','isinstance','issubclass','super','object',
  'Exception','ValueError','TypeError','KeyError','IndexError',
]);

// ─── Tokeniser ────────────────────────────────────────────────────────────────
function tokenise(code: string, language: string): Token[][] {
  const isJS = language !== 'python';
  const keywords = isJS ? JS_KEYWORDS : PY_KEYWORDS;
  const builtins = isJS ? JS_BUILTINS : PY_BUILTINS;

  const lines = code.split('\n');
  const result: Token[][] = [];

  // Simple single-pass regex tokeniser per line.
  // Order matters: more specific patterns first.
  const TOKEN_RE = isJS
    ? /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_$][\w$]*)(\s*\()?|([=!<>+\-*/%&|^~?:]+)/g
    : /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""[\s\S]*?"""|'''[\s\S]*?''')|#[^\n]*|(0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_][\w]*)(\s*\()?|([=!<>+\-*/%&|^~?:]+)/g;

  let inBlockComment = false; // JS /* */ spanning lines

  for (const line of lines) {
    const tokens: Token[] = [];
    let i = 0;

    while (i < line.length) {
      // Handle ongoing JS block comment
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          tokens.push({ type: 'comment', value: line.slice(i) });
          i = line.length;
          break;
        } else {
          tokens.push({ type: 'comment', value: line.slice(i, end + 2) });
          i = end + 2;
          inBlockComment = false;
          continue;
        }
      }

      // Single-line Python comment
      if (language === 'python' && line[i] === '#') {
        tokens.push({ type: 'comment', value: line.slice(i) });
        break;
      }

      // JS line comment
      if (isJS && line[i] === '/' && line[i + 1] === '/') {
        tokens.push({ type: 'comment', value: line.slice(i) });
        break;
      }

      // JS block comment start
      if (isJS && line[i] === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end === -1) {
          tokens.push({ type: 'comment', value: line.slice(i) });
          inBlockComment = true;
          i = line.length;
          break;
        } else {
          tokens.push({ type: 'comment', value: line.slice(i, end + 2) });
          i = end + 2;
          continue;
        }
      }

      // String literals
      const quote = line[i];
      if (quote === '"' || quote === "'" || (isJS && quote === '`')) {
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === quote) { j++; break; }
          j++;
        }
        tokens.push({ type: 'string', value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Python triple-quoted string (only detect open on this line; simplified)
      if (language === 'python' && (line.slice(i, i + 3) === '"""' || line.slice(i, i + 3) === "'''")) {
        const tq = line.slice(i, i + 3);
        const end = line.indexOf(tq, i + 3);
        if (end !== -1) {
          tokens.push({ type: 'string', value: line.slice(i, end + 3) });
          i = end + 3;
        } else {
          tokens.push({ type: 'string', value: line.slice(i) });
          i = line.length;
        }
        continue;
      }

      // Numbers
      if (/\d/.test(line[i]) || (line[i] === '.' && /\d/.test(line[i + 1] ?? ''))) {
        let j = i;
        if (line[j] === '0' && (line[j + 1] === 'x' || line[j + 1] === 'X')) {
          j += 2;
          while (j < line.length && /[\da-fA-F]/.test(line[j])) j++;
        } else {
          while (j < line.length && /[\d.]/.test(line[j])) j++;
          if (j < line.length && (line[j] === 'e' || line[j] === 'E')) {
            j++;
            if (j < line.length && (line[j] === '+' || line[j] === '-')) j++;
            while (j < line.length && /\d/.test(line[j])) j++;
          }
        }
        tokens.push({ type: 'number', value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Identifiers / keywords / builtins / functions
      if (/[A-Za-z_$]/.test(line[i])) {
        let j = i + 1;
        while (j < line.length && /[\w$]/.test(line[j])) j++;
        const word = line.slice(i, j);
        // Peek ahead for '(' to detect function calls/definitions
        let k = j;
        while (k < line.length && line[k] === ' ') k++;
        const isCall = line[k] === '(';

        let type: TokenType;
        if (keywords.has(word)) type = 'keyword';
        else if (builtins.has(word)) type = 'builtin';
        else if (isCall) type = 'function';
        else type = 'plain';

        tokens.push({ type, value: word });
        i = j;
        continue;
      }

      // Operators
      if (/[=!<>+\-*/%&|^~?:]/.test(line[i])) {
        let j = i + 1;
        while (j < line.length && /[=!<>+\-*/%&|^~?:]/.test(line[j])) j++;
        tokens.push({ type: 'operator', value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Fallback: single plain character (punctuation, whitespace, etc.)
      tokens.push({ type: 'plain', value: line[i] });
      i++;
    }

    result.push(tokens);
  }

  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────
interface Props {
  code: string;
  language: string;
  /** Called with the 0-based index of the line the user tapped. */
  onLinePress?: (lineIndex: number) => void;
  style?: object;
  /** Forwarded to the internal ScrollView so the parent can call scrollTo(). */
  scrollRef?: React.RefObject<ScrollView | null>;
  /** Scroll offset to restore when this component mounts (pixels). */
  initialScrollY?: number;
  /** Called on every scroll event with the current Y offset. */
  onScrollY?: (y: number) => void;
}

const FONT_FAMILY = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

/** Shared line-height for code lines. Import this wherever scroll offsets are calculated. */
export const CODE_LINE_HEIGHT = 20;

export const SyntaxHighlighter = memo(function SyntaxHighlighter({
  code,
  language,
  onLinePress,
  style,
  scrollRef,
  initialScrollY,
  onScrollY,
}: Props) {
  const lines = tokenise(code || '', language);

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.scroll, style]}
      contentContainerStyle={styles.content}
      contentOffset={initialScrollY ? { x: 0, y: initialScrollY } : undefined}
      onScroll={onScrollY ? (e) => onScrollY(e.nativeEvent.contentOffset.y) : undefined}
      scrollEventThrottle={16}
      scrollEnabled
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
    >
      {lines.map((lineTokens, lineIndex) => (
        <Pressable
          key={lineIndex}
          onPress={() => onLinePress?.(lineIndex)}
          style={styles.line}
        >
          {/* Line number */}
          <Text style={styles.lineNum}>
            {String(lineIndex + 1).padStart(3, ' ')}
          </Text>
          {/* Tokens */}
          <Text style={styles.codeLine}>
            {lineTokens.map((tok, ti) => (
              <Text key={ti} style={{ color: syntaxColors[tok.type] }}>
                {tok.value}
              </Text>
            ))}
            {/* Trailing newline spacer so empty lines have height */}
            {lineTokens.length === 0 ? ' ' : ''}
          </Text>
        </Pressable>
      ))}
      {/* Extra bottom padding so last line isn't clipped by terminal */}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingVertical: 10,
  },
  line: {
    flexDirection: 'row',
    minHeight: CODE_LINE_HEIGHT,
  },
  lineNum: {
    width: 38,
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    fontFamily: FONT_FAMILY,
    color: '#444c56',
    textAlign: 'right',
    paddingRight: 10,
    userSelect: 'none',
  },
  codeLine: {
    flex: 1,
    fontSize: 13,
    lineHeight: CODE_LINE_HEIGHT,
    fontFamily: FONT_FAMILY,
    paddingRight: 14,
  },
});
