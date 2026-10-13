import { Font, StyleSheet } from "@react-pdf/renderer"
import path from "node:path"

// PDF standard fonts use WinAnsi encoding and cannot render Greek letters or
// many math symbols. Embed local fonts so printing never depends on a CDN or
// on fonts installed on the server (including the standalone Docker image).
const fontDirectory = path.join(process.cwd(), "public/fonts/dejavu")

Font.register({
  family: "DejaVu Sans",
  fonts: [
    { src: path.join(fontDirectory, "DejaVuSans.ttf") },
    { src: path.join(fontDirectory, "DejaVuSans-Bold.ttf"), fontWeight: 700 },
    {
      src: path.join(fontDirectory, "DejaVuSans-Oblique.ttf"),
      fontStyle: "italic",
    },
    {
      src: path.join(fontDirectory, "DejaVuSans-BoldOblique.ttf"),
      fontWeight: 700,
      fontStyle: "italic",
    },
  ],
})
Font.register({
  family: "DejaVu Sans Mono",
  src: path.join(fontDirectory, "DejaVuSansMono.ttf"),
})

export const pdfColors = {
  ink: "#0f172a",
  muted: "#475569",
  faint: "#94a3b8",
  rule: "#cbd5e1",
  accent: "#2563eb",
  success: "#15803d",
  paper: "#ffffff",
}

export const pdfStyles = StyleSheet.create({
  page: {
    paddingVertical: 48,
    paddingHorizontal: 44,
    fontSize: 9.5,
    fontFamily: "DejaVu Sans",
    color: pdfColors.ink,
  },
  title: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: pdfColors.muted,
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: "row",
    gap: 16,
    fontSize: 9,
    color: pdfColors.muted,
    marginTop: 4,
    marginBottom: 10,
  },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: pdfColors.rule,
    marginVertical: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "bold",
    marginBottom: 8,
    marginTop: 4,
  },
  questionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 10,
    marginBottom: 4,
  },
  questionTitle: {
    flexGrow: 1,
    fontSize: 10.5,
    fontWeight: "bold",
    lineHeight: 1.4,
    paddingRight: 8,
  },
  points: {
    fontSize: 9,
    color: pdfColors.muted,
    paddingTop: 1,
  },
  optionRow: {
    flexDirection: "row",
    marginBottom: 3,
    paddingLeft: 2,
  },
  optionText: {
    flexGrow: 1,
    fontSize: 9.5,
    lineHeight: 1.35,
  },
  blank: {
    color: pdfColors.faint,
  },
  code: {
    fontFamily: "DejaVu Sans Mono",
    fontSize: 8,
    lineHeight: 1.4,
    backgroundColor: "#f1f5f9",
    padding: 6,
    marginBottom: 6,
    borderWidth: 0.5,
    borderColor: pdfColors.rule,
    borderRadius: 3,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 2,
  },
  sheetName: {
    fontSize: 13,
    fontWeight: "bold",
  },
  sheetMeta: {
    fontSize: 9,
    color: pdfColors.muted,
    marginBottom: 1,
  },
  answerBlock: {
    marginBottom: 2,
  },
  answerLabel: {
    fontSize: 9,
    fontWeight: "bold",
    marginBottom: 2,
    marginTop: 2,
  },
  answerText: {
    fontSize: 9.5,
    lineHeight: 1.4,
  },
  gradePill: {
    fontSize: 9,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: pdfColors.rule,
  },
  feedback: {
    fontSize: 9,
    color: pdfColors.muted,
    fontStyle: "italic",
    marginTop: 3,
    lineHeight: 1.4,
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: pdfColors.faint,
    borderTopWidth: 0.5,
    borderTopColor: pdfColors.rule,
    paddingTop: 4,
  },
})
