"use client"

import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"

import { useEffect, useRef } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CalendarIcon, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { createExamSchema, type CreateExamInput } from "@/lib/validators/exam"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import {
  fromSwissWallTime,
  toSwissWallTime,
  type SwissWallTime,
} from "@/lib/format-date"
import { HelpTip } from "@/components/help-tip"

const SWITCH_FIELDS = new Set([
  "shuffleQuestions",
  "shuffleOptions",
  "showResults",
  "sebRequired",
  "waitingRoom",
])

const SWITCH_HELP: Record<string, string> = {
  shuffleQuestions:
    "Jede Teilnehmerin und jeder Teilnehmer erhält die Fragen in einer anderen Reihenfolge. Das erschwert das Abschauen zwischen Nachbarplätzen.",
  shuffleOptions:
    "Bei Multiple-Choice-Fragen werden die Antwortmöglichkeiten (A, B, C, …) für jede Person einzeln gemischt.",
  sebRequired:
    "Die Prüfung muss im Safe Exam Browser (SEB) geschrieben werden — einer abgeschotteten Browser-App, die das Öffnen anderer Programme und Webseiten blockiert. Sie erhalten dafür automatisch eine Konfigurationsdatei zum Verteilen, und die Prüfung wird zusätzlich technisch überwacht.",
}

const WAITING_ROOM_HELP =
  "Ab dem geplanten Start (oder sofort, wenn keiner gesetzt ist) können Schüler:innen einem Warteraum beitreten — mit SEB bereits im Safe Exam Browser. Sie starten die Prüfung im Live-Monitor für alle gleichzeitig; alle erhalten die volle Dauer ab diesem Moment. Wer später beitritt, erhält ebenfalls die volle Dauer ab dem eigenen Beitritt."

export type SaveStatus = "idle" | "saving" | "saved" | "error"

const pad = (n: number) => String(n).padStart(2, "0")

function formatWallDate(w: SwissWallTime): string {
  return `${pad(w.day)}.${pad(w.month)}.${w.year}`
}

interface DateTimeFieldProps {
  id: string
  label: string
  value?: string | null
  // null clears a stored value. undefined (never set) is left out of the
  // PATCH body, so emitting it could never remove a schedule again.
  onChange: (iso: string | null) => void
  invalid?: boolean
}

function DateTimeField({
  id,
  label,
  value,
  onChange,
  invalid,
}: DateTimeFieldProps) {
  // The schedule is Swiss time (lib/format-date.ts), whatever time zone the
  // browser is in: the exam list shows it that way, so the picker reads and
  // writes Zurich wall-clock time too.
  const date = value ? new Date(value) : undefined
  const validDate = date && !Number.isNaN(date.getTime()) ? date : undefined
  const wall = validDate ? toSwissWallTime(validDate) : undefined
  const timeValue = wall ? `${pad(wall.hour)}:${pad(wall.minute)}` : ""
  // react-day-picker works on local dates; show the Swiss day as one.
  const calendarDay = wall
    ? new Date(wall.year, wall.month - 1, wall.day)
    : undefined

  function handleDateSelect(selected?: Date) {
    if (!selected) {
      onChange(null)
      return
    }
    const next = fromSwissWallTime({
      year: selected.getFullYear(),
      month: selected.getMonth() + 1,
      day: selected.getDate(),
      hour: wall?.hour ?? 0,
      minute: wall?.minute ?? 0,
    })
    onChange(next.toISOString())
  }

  function handleTimeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const [hours, minutes] = e.target.value.split(":").map(Number)
    const base = wall ?? toSwissWallTime(new Date())
    const next = fromSwissWallTime({
      ...base,
      hour: hours || 0,
      minute: minutes || 0,
    })
    onChange(next.toISOString())
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            className="w-full justify-start font-normal"
            aria-invalid={invalid}
          >
            <CalendarIcon data-icon="inline-start" />
            {wall ? formatWallDate(wall) : "Datum wählen"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={calendarDay}
            defaultMonth={calendarDay}
            onSelect={handleDateSelect}
          />
        </PopoverContent>
      </Popover>
      <div className="flex gap-1">
        <Input
          type="time"
          value={timeValue}
          onChange={handleTimeChange}
          className="w-full"
          aria-label="Uhrzeit"
          aria-invalid={invalid}
        />
        {validDate && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
            aria-label={`${label} entfernen`}
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  )
}

interface ExamMetadataFormProps {
  hasFileUploadQuestions?: boolean
  defaultValues?: Partial<CreateExamInput>
  onSubmit: (data: CreateExamInput) => Promise<void>
  isLoading?: boolean
  submitLabel?: string
  /** When true (editing an existing exam), fields autosave and the submit button is hidden. */
  autosave?: boolean
  onStatusChange?: (status: SaveStatus) => void
}

export function ExamMetadataForm({
  defaultValues,
  hasFileUploadQuestions = false,
  onSubmit,
  isLoading,
  submitLabel = "Speichern",
  autosave = false,
  onStatusChange,
}: ExamMetadataFormProps) {
  const {
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateExamInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createExamSchema) as any,
    defaultValues: {
      title: "",
      description: "",
      timeLimitMin: 60,
      shuffleQuestions: false,
      shuffleOptions: false,
      showResults: false,
      sebRequired: false,
      waitingRoom: false,
      ...defaultValues,
    },
  })

  const waitingRoom = watch("waitingRoom")

  const editSeqRef = useRef(0)
  const saveVersionRef = useRef(0)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  function save(data: CreateExamInput, version: number) {
    // Serialize requests, and discard snapshots superseded while they were
    // debounced or waiting behind an in-flight request. A switch must never
    // be overwritten by an older full-form text snapshot. Only that version
    // check may skip a queued request: navigating away right after a switch
    // must not drop the save, so mountedRef gates just the status callbacks.
    saveChainRef.current = saveChainRef.current.then(async () => {
      if (version !== saveVersionRef.current) return
      try {
        await onSubmit(data)
        if (mountedRef.current && version === saveVersionRef.current) {
          onStatusChange?.("saved")
        }
      } catch {
        if (mountedRef.current && version === saveVersionRef.current) {
          onStatusChange?.("error")
        }
      }
    })
  }

  // flushOnUnmount: the status line already said "saving" for the pending
  // snapshot, so dropping it would lose an edit the UI promised to write.
  // save() runs it after teardown with its status callbacks gated away.
  const debouncedSave = useDebouncedCallback(
    (data: CreateExamInput, version: number) => {
      save(data, version)
    },
    600,
    { flushOnUnmount: true }
  )

  useEffect(() => {
    if (!autosave) return
    // React Compiler cannot memoize a component that calls react-hook-form's
    // watch(), so it skips this one and says so on every lint run. Accepted
    // rather than fixed: the alternative is useWatch or a controlled form,
    // both of which re-render the whole metadata form on every keystroke —
    // the cost this subscription exists to avoid — and the autosave path is
    // not somewhere to take a behavioural change for a memoization hint.
    // eslint-disable-next-line react-hooks/incompatible-library
    const subscription = watch((_values, { name }) => {
      // Stamp the sequence synchronously, at edit time: a snapshot's version
      // must reflect when it was edited, not when its validation resolved,
      // so an older snapshot can never outrank a newer one. Validation only
      // gates eligibility. No onInvalid handler: an invalid snapshot (an
      // empty title while retyping) is not a rejected save — it must neither
      // show the error status nor cancel a valid save already queued, so it
      // leaves the save version untouched and the inline field errors
      // explain what to fix.
      const seq = ++editSeqRef.current
      handleSubmit((data) => {
        if (seq < saveVersionRef.current) return
        saveVersionRef.current = seq
        if (mountedRef.current) onStatusChange?.("saving")
        if (name && SWITCH_FIELDS.has(name)) {
          save(data, seq)
        } else {
          debouncedSave(data, seq)
        }
      })()
    })
    return () => subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave, watch])

  return (
    <form
      onSubmit={autosave ? (e) => e.preventDefault() : handleSubmit(onSubmit)}
      className="space-y-5"
    >
      <FieldGroup>
        <Field data-invalid={!!errors.title}>
          <FieldLabel htmlFor="title">Titel *</FieldLabel>
          <Controller
            name="title"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                id="title"
                placeholder="z.B. Mathematik Abschlussprüfung"
                aria-invalid={!!errors.title}
              />
            )}
          />
          <FieldError errors={[errors.title]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="description">Beschreibung</FieldLabel>
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <Textarea
                {...field}
                id="description"
                value={field.value ?? ""}
                placeholder="Optionale Beschreibung…"
                rows={3}
              />
            )}
          />
        </Field>

        <Field data-invalid={!!errors.timeLimitMin}>
          <FieldLabel htmlFor="timeLimitMin">Dauer (Minuten) *</FieldLabel>
          <Controller
            name="timeLimitMin"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ""}
                id="timeLimitMin"
                type="number"
                min={1}
                max={600}
                onChange={(e) => {
                  const raw = e.target.value
                  const parsed = raw === "" ? undefined : Number(raw)
                  field.onChange(
                    parsed === undefined || Number.isNaN(parsed)
                      ? undefined
                      : parsed
                  )
                }}
                aria-invalid={!!errors.timeLimitMin}
              />
            )}
          />
          <FieldError errors={[errors.timeLimitMin]} />
        </Field>

        <Controller
          name="waitingRoom"
          control={control}
          render={({ field }) => (
            <Field orientation="horizontal" className="rounded-lg border p-4">
              <FieldContent>
                <span className="flex items-center gap-1.5">
                  <FieldLabel
                    htmlFor="waitingRoom"
                    className="cursor-pointer font-normal"
                  >
                    Gemeinsamer Start mit Warteraum
                  </FieldLabel>
                  <HelpTip content={WAITING_ROOM_HELP} />
                </span>
                <FieldDescription className="text-xs">
                  Alle beginnen gleichzeitig, sobald Sie die Prüfung starten.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="waitingRoom"
                checked={field.value ?? false}
                onCheckedChange={(checked) => {
                  field.onChange(checked)
                  // No scheduled end with a shared start. Cleared after the
                  // switch, not before: each change snapshots the form for
                  // autosave, and clearing first queued a debounced save of
                  // the pre-switch values that landed after (and undid) the
                  // switch's own save. In this order a stored end makes the
                  // switch's snapshot invalid (skipped), and the clear's
                  // snapshot carries both changes.
                  if (checked) setValue("scheduledEnd", null)
                }}
              />
            </Field>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="scheduledStart">
              {waitingRoom ? "Warteraum öffnet ab" : "Geplanter Start"}
            </FieldLabel>
            <Controller
              name="scheduledStart"
              control={control}
              render={({ field }) => (
                <DateTimeField
                  id="scheduledStart"
                  label={waitingRoom ? "Warteraum-Öffnung" : "Geplanter Start"}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </Field>
          {!waitingRoom && (
            <Field data-invalid={!!errors.scheduledEnd}>
              <FieldLabel htmlFor="scheduledEnd">Geplantes Ende</FieldLabel>
              <Controller
                name="scheduledEnd"
                control={control}
                render={({ field }) => (
                  <DateTimeField
                    id="scheduledEnd"
                    label="Geplantes Ende"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={!!errors.scheduledEnd}
                  />
                )}
              />
              {/* Autosave skips an invalid form, so without this the edit was
                  dropped with nothing on screen saying why. */}
              <FieldError errors={[errors.scheduledEnd]} />
            </Field>
          )}
        </div>

        <FieldSet className="gap-3 rounded-lg border p-4">
          <FieldLegend variant="label">Einstellungen</FieldLegend>
          {(
            [
              [
                "shuffleQuestions",
                "Fragen zufällig anordnen",
                "Die Fragen erscheinen bei jedem Teilnehmenden in zufälliger Reihenfolge.",
              ],
              [
                "shuffleOptions",
                "Antwortoptionen mischen",
                "Die Antwortoptionen werden pro Sitzung neu gemischt.",
              ],
              [
                "sebRequired",
                "Safe Exam Browser erforderlich",
                "Die Prüfung kann nur im Safe Exam Browser (Kiosk-Modus) geöffnet werden.",
              ],
            ] as const
          ).map(([name, label, description]) => (
            <Controller
              key={name}
              name={name}
              control={control}
              render={({ field }) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <span className="flex items-center gap-1.5">
                      <FieldLabel
                        htmlFor={name}
                        className="cursor-pointer font-normal"
                      >
                        {label}
                      </FieldLabel>
                      <HelpTip content={SWITCH_HELP[name]} />
                    </span>
                    <FieldDescription className="text-xs">
                      {name === "sebRequired" && hasFileUploadQuestions
                        ? SEB_FILE_UPLOAD_MESSAGE
                        : description}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={name}
                    disabled={
                      name === "sebRequired" &&
                      hasFileUploadQuestions &&
                      !field.value
                    }
                    checked={field.value ?? false}
                    onCheckedChange={field.onChange}
                  />
                </Field>
              )}
            />
          ))}
        </FieldSet>
      </FieldGroup>

      <div className="rounded-lg border p-4">
        <Controller
          name="showResults"
          control={control}
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel
                  htmlFor="showResults"
                  className="cursor-pointer font-normal"
                >
                  Ergebnisse automatisch freigeben
                </FieldLabel>
                <FieldDescription className="text-xs">
                  Nur ein Startwert: Sobald die Prüfung bewertet ist,
                  entscheidest du dort explizit, ob die Ergebnisse für
                  Schüler:innen sichtbar werden.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="showResults"
                checked={field.value ?? false}
                onCheckedChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      {!autosave && (
        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? (
            <>
              <Spinner data-icon="inline-start" />
              Wird gespeichert…
            </>
          ) : (
            submitLabel
          )}
        </Button>
      )}
    </form>
  )
}
