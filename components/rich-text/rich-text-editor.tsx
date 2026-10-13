"use client"

import { useEffect, useRef } from "react"
import { useEditor, EditorContent, useEditorState } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { CharacterCount, Placeholder } from "@tiptap/extensions"
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { escapeHtmlText, looksLikeHtml } from "@/lib/html-sanitize"

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  maxLength: number
  placeholder?: string
}

interface ToolbarButtonProps {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export function RichTextEditor({
  value,
  onChange,
  maxLength,
  placeholder = "Antwort eingeben…",
}: RichTextEditorProps) {
  const emittedRef = useRef(value)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      // No links: this is the student's answer editor inside SEB. StarterKit
      // v3 bundles Link with autolink + openOnClick, so a typed or pasted
      // /exam/<id>/quit URL would become a clickable full navigation to the
      // quitURL — an exit from SEB without the quit password.
      StarterKit.configure({ link: false }),
      Placeholder.configure({ placeholder }),
      CharacterCount.configure({ limit: maxLength }),
    ],
    content: looksLikeHtml(value) ? value : escapeHtmlText(value),
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      emittedRef.current = html
      onChange(html)
    },
  })

  // Keep the editor in sync with controlled value changes that did not
  // originate from this editor (autosave restore, answer reset, …).
  useEffect(() => {
    if (!editor) return
    if (value === emittedRef.current) return
    if (editor.getHTML() === value) return
    editor.commands.setContent(
      looksLikeHtml(value) ? value : escapeHtmlText(value)
    )
    emittedRef.current = value
  }, [value, editor])

  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor) {
        return {
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          h1: false,
          h2: false,
          h3: false,
          bullet: false,
          ordered: false,
          quote: false,
          code: false,
          canUndo: false,
          canRedo: false,
          charCount: 0,
        }
      }
      return {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        h1: editor.isActive("heading", { level: 1 }),
        h2: editor.isActive("heading", { level: 2 }),
        h3: editor.isActive("heading", { level: 3 }),
        bullet: editor.isActive("bulletList"),
        ordered: editor.isActive("orderedList"),
        quote: editor.isActive("blockquote"),
        code: editor.isActive("codeBlock"),
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
        charCount: editor.storage.characterCount?.characters?.() ?? 0,
      }
    },
  })

  if (!editor || !state) return null

  const overLimit = state.charCount > maxLength

  return (
    <div
      className={cn(
        "rich-text-editor rounded-lg border border-input bg-background transition-all",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      )}
    >
      <div
        role="toolbar"
        aria-label="Formatierung"
        className="flex flex-wrap items-center gap-0.5 border-b border-input bg-muted/30 px-1 py-1"
      >
        <ToolbarButton
          label="Rückgängig"
          disabled={!state.canUndo}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 />
        </ToolbarButton>
        <ToolbarButton
          label="Wiederholen"
          disabled={!state.canRedo}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 />
        </ToolbarButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <ToolbarButton
          label="Fett"
          active={state.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold />
        </ToolbarButton>
        <ToolbarButton
          label="Kursiv"
          active={state.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic />
        </ToolbarButton>
        <ToolbarButton
          label="Unterstrichen"
          active={state.underline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline />
        </ToolbarButton>
        <ToolbarButton
          label="Durchgestrichen"
          active={state.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough />
        </ToolbarButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <ToolbarButton
          label="Überschrift 1"
          active={state.h1}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
        >
          <Heading1 />
        </ToolbarButton>
        <ToolbarButton
          label="Überschrift 2"
          active={state.h2}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton
          label="Überschrift 3"
          active={state.h3}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
        >
          <Heading3 />
        </ToolbarButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <ToolbarButton
          label="Aufzählungsliste"
          active={state.bullet}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List />
        </ToolbarButton>
        <ToolbarButton
          label="Nummerierte Liste"
          active={state.ordered}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton
          label="Zitat"
          active={state.quote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote />
        </ToolbarButton>
        <ToolbarButton
          label="Codeblock"
          active={state.code}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 />
        </ToolbarButton>
      </div>

      <EditorContent editor={editor} />

      <p
        className={cn(
          "px-3 pb-1.5 text-right text-xs text-muted-foreground",
          overLimit && "font-medium text-destructive"
        )}
      >
        {state.charCount} / {maxLength}
      </p>
    </div>
  )
}
