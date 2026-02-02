/**
 * Signal Text Formatting
 * 
 * Converts simple markdown (*bold*, _italic_, `code`) to Signal style ranges.
 * Uses single-pass processing to correctly track positions.
 */

export type SignalStyleRange = {
  start: number;
  length: number;
  style: 'BOLD' | 'ITALIC' | 'MONOSPACE' | 'STRIKETHROUGH';
};

export type SignalFormattedText = {
  text: string;
  styles: SignalStyleRange[];
};

interface FoundMatch {
  index: number;
  fullMatch: string;
  content: string;
  style: SignalStyleRange['style'];
  markerLen: number;
}

/**
 * Convert markdown text to Signal formatted text with style ranges.
 * Supports: **bold**, *bold*, __italic__, _italic_, `code`, ~~strikethrough~~
 */
export function markdownToSignal(markdown: string): SignalFormattedText {
  // Find all matches first, then process in order
  const patterns: Array<{
    regex: RegExp;
    style: SignalStyleRange['style'];
    markerLen: number;
  }> = [
    { regex: /\*\*(.+?)\*\*/g, style: 'BOLD', markerLen: 2 },      // **bold**
    { regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, style: 'BOLD', markerLen: 1 },  // *bold* (not **)
    { regex: /__(.+?)__/g, style: 'ITALIC', markerLen: 2 },        // __italic__
    { regex: /(?<!_)_([^_]+)_(?!_)/g, style: 'ITALIC', markerLen: 1 },    // _italic_ (not __)
    { regex: /~~(.+?)~~/g, style: 'STRIKETHROUGH', markerLen: 2 }, // ~~strike~~
    { regex: /`([^`]+)`/g, style: 'MONOSPACE', markerLen: 1 },     // `code`
  ];
  
  // Collect all matches with their original positions
  const allMatches: FoundMatch[] = [];
  
  for (const { regex, style, markerLen } of patterns) {
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      allMatches.push({
        index: match.index,
        fullMatch: match[0],
        content: match[1],
        style,
        markerLen,
      });
    }
  }
  
  // Sort by position (earlier first), then by length (longer first for overlapping)
  allMatches.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return b.fullMatch.length - a.fullMatch.length;
  });
  
  // Remove overlapping matches (keep the first/longer one)
  const filteredMatches: FoundMatch[] = [];
  let lastEnd = -1;
  
  for (const m of allMatches) {
    if (m.index >= lastEnd) {
      filteredMatches.push(m);
      lastEnd = m.index + m.fullMatch.length;
    }
  }
  
  // Build output text and styles in single pass
  const styles: SignalStyleRange[] = [];
  const textParts: string[] = [];
  let srcPos = 0;
  let dstPos = 0;
  
  for (const m of filteredMatches) {
    // Add text before this match
    if (m.index > srcPos) {
      const before = markdown.slice(srcPos, m.index);
      textParts.push(before);
      dstPos += before.length;
    }
    
    // Add the content (without markers)
    textParts.push(m.content);
    
    // Record style at current destination position
    styles.push({
      start: dstPos,
      length: m.content.length,
      style: m.style,
    });
    
    dstPos += m.content.length;
    srcPos = m.index + m.fullMatch.length;
  }
  
  // Add remaining text
  if (srcPos < markdown.length) {
    textParts.push(markdown.slice(srcPos));
  }
  
  return { text: textParts.join(''), styles };
}

/**
 * Format styles for signal-cli text-style parameter
 */
export function formatStylesForCli(styles: SignalStyleRange[]): string[] {
  return styles.map(s => `${s.start}:${s.length}:${s.style}`);
}
