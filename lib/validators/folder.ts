import { z } from "zod"

export const createFolderSchema = z.object({
  // Trimmed so "   " is refused instead of creating a folder with a blank
  // name, and " Mathe" cannot sit next to "Mathe".
  name: z.string().trim().min(1, "Name ist erforderlich").max(100),
})

export type CreateFolderInput = z.infer<typeof createFolderSchema>
