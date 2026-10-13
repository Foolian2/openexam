import { SettingsSection } from "@/components/settings/settings-section"
import { AccessibilityToggle } from "@/components/accessibility-toggle"
import { DyslexicFontToggle } from "@/components/dyslexic-font-toggle"

interface AccessibilitySettingsProps {
  // The first three preferences are applied across the whole dashboard for
  // every role, so they stay visible unconditionally — they are also the
  // only controls that can switch them back off. Only the exam countdown is
  // specific to sitting an exam.
  showExamTimerPref?: boolean
}

export function AccessibilitySettings({
  showExamTimerPref = true,
}: AccessibilitySettingsProps) {
  return (
    <SettingsSection
      title="Barrierefreiheit"
      description="Passen Sie die Darstellung an Ihre Bedürfnisse an."
    >
      <div className="flex flex-col gap-4">
        <DyslexicFontToggle variant="switch" label="OpenDyslexic-Schriftart" />
        <AccessibilityToggle
          pref="highContrast"
          variant="switch"
          label="Hoher Kontrast"
        />
        <AccessibilityToggle
          pref="reducedMotion"
          variant="switch"
          label="Reduzierte Bewegung"
        />
        {showExamTimerPref && (
          <AccessibilityToggle
            pref="hideExamTimer"
            variant="switch"
            label="Prüfungs-Countdown ausblenden"
          />
        )}
      </div>
    </SettingsSection>
  )
}
