export interface MCAnswer {
  selectedOptionIds: string[]
}

export interface FreeTextAnswer {
  text: string
}

export interface FillBlankAnswer {
  blanks: {
    id: string
    value: string
  }[]
}

export interface FileUploadAnswer {
  fileKey: string
  fileName: string
}

export interface MatchingAnswer {
  matches: {
    leftId: string
    rightId: string
  }[]
}

export interface CodeAnswer {
  code: string
  language: string
}

/** TRUE_FALSE answer: the boolean the student selected (true = "Wahr"). */
export interface TrueFalseAnswer {
  selected: boolean
}

/** SHORT_ANSWER answer: the trimmed text the student typed. */
export interface ShortAnswerAnswer {
  text: string
}

/**
 * ORDERING answer: the item ids in the order the student arranged them.
 * Grading compares this against `OrderingConfig.items` (which is stored
 * in the correct order) position by position.
 */
export interface OrderingAnswer {
  orderedIds: string[]
}
