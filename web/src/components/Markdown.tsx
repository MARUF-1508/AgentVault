import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { shortAddr } from '../format';

/**
 * Turns explorer-relevant hashes into markdown links, leaving URLs the model
 * already wrote alone. Runs before markdown parsing, so addresses inside code
 * spans would also linkify — acceptable for agent prose (it never puts them in
 * code fences on purpose).
 */
export function markdownify(text: string, explorer: string | null): string {
  if (!explorer) return text;
  return text.replace(
    /(https?:\/\/[^\s)]+)|(0x[0-9a-fA-F]{64})|(0x[0-9a-fA-F]{40})/g,
    (match, url: string | undefined, tx: string | undefined) => {
      if (url) return url;
      const kind = tx ? 'tx' : 'address';
      return `[${shortAddr(match)}](${explorer}/${kind}/${match})`;
    },
  );
}

/** Renders agent replies as markdown (GFM tables, lists, code) with safe links. */
export default function Markdown({ text, explorer }: { text: string; explorer: string | null }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {markdownify(text, explorer)}
      </ReactMarkdown>
    </div>
  );
}
