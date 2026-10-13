import { ImageResponse } from "next/og"

// Home-screen icon: the logo mark on a highlighter-yellow tile. iOS does not
// accept SVG touch icons, so this is rendered to PNG at build time.
export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FFD23F",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 100 100">
        <path
          d="M18 4H70L96 30V82Q96 96 82 96H18Q4 96 4 82V18Q4 4 18 4Z"
          fill="#1E1B18"
        />
        <path d="M70 4V22Q70 30 78 30H96Z" fill="#FBF8F1" />
        <rect x="22" y="36" width="44" height="10" rx="5" fill="#FBF8F1" />
        <rect x="22" y="50" width="34" height="10" rx="5" fill="#FFD23F" />
        <rect x="22" y="64" width="44" height="10" rx="5" fill="#FBF8F1" />
      </svg>
    </div>,
    size
  )
}
