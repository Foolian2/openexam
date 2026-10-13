"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  BarChart2,
  BookMarked,
  ChevronsUpDown,
  ClipboardList,
  Folder,
  LayoutDashboard,
  LogOut,
  MonitorPlay,
  ScrollText,
  Settings,
  ShieldCheck,
} from "lucide-react"

import { signOut } from "@/lib/auth-client"
import { ThemeToggle } from "@/components/theme-toggle"
import { NewFolderDialog } from "@/components/dashboard/new-folder-dialog"
import { FolderActions } from "@/components/dashboard/folder-actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Logo } from "@/components/brand/logo"

interface SidebarFolder {
  id: string
  name: string
  _count: { exams: number }
}

interface AppSidebarProps {
  role: string
  userName: string
  userEmail: string
  folders?: SidebarFolder[]
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

function getTeacherNavItems(settingsRoute: string) {
  return [
    {
      label: "Prüfungen",
      icon: ClipboardList,
      route: "/dashboard/teacher",
      exact: false,
    },
    {
      label: "Live-Monitor",
      icon: MonitorPlay,
      route: "/dashboard/teacher/monitor",
      exact: true,
    },
    {
      label: "Bewertungen",
      icon: BarChart2,
      route: "/dashboard/teacher/grades",
      exact: true,
    },
    {
      label: "Fragenbank",
      icon: BookMarked,
      route: "/dashboard/teacher/question-bank",
      exact: true,
    },
    {
      label: "Audit-Log",
      icon: ScrollText,
      route: "/dashboard/teacher/audit",
      exact: true,
    },
    {
      label: "Einstellungen",
      icon: Settings,
      route: settingsRoute,
      exact: true,
    },
  ]
}

const studentNavItems = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    route: "/dashboard/student",
    exact: true,
  },
  {
    label: "Einstellungen",
    icon: Settings,
    route: "/dashboard/student/settings",
    exact: true,
  },
]

export function AppSidebar({
  role,
  userName,
  userEmail,
  folders: serverFolders = [],
}: AppSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isStudent = role === "STUDENT"
  const settingsRoute =
    role === "ADMIN"
      ? "/dashboard/admin/settings"
      : "/dashboard/teacher/settings"
  const mainNavItems = isStudent
    ? studentNavItems
    : getTeacherNavItems(settingsRoute)
  const activeFolderId =
    pathname === "/dashboard/teacher" ? searchParams.get("folder") : null

  // The server-provided `folders` prop only updates once router.refresh()'s
  // RSC round trip lands, which can lag a tick behind the DELETE/PATCH
  // response. These overlays let deletes/renames reflect instantly.
  const [hiddenFolderIds, setHiddenFolderIds] = useState<Set<string>>(new Set())
  const [renamedFolders, setRenamedFolders] = useState<Record<string, string>>(
    {}
  )
  const folders = serverFolders
    .filter((folder) => !hiddenFolderIds.has(folder.id))
    .map((folder) =>
      renamedFolders[folder.id]
        ? { ...folder, name: renamedFolders[folder.id] }
        : folder
    )

  function isActive(route: string, exact: boolean): boolean {
    if (exact) {
      return pathname === route
    }
    // For Prüfungen: active on /dashboard/teacher or /dashboard/teacher/exams/*
    return pathname === route || pathname.startsWith("/dashboard/teacher/exams")
  }

  async function handleSignOut() {
    await signOut()
    router.push("/login")
  }

  const initials = getInitials(userName)

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center px-2 py-1">
          <Logo className="text-lg" markClassName="size-7" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.route}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.route, item.exact)}
                  >
                    <Link href={item.route}>
                      <item.icon data-icon="inline-start" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {!isStudent && item.route === "/dashboard/teacher" && (
                    <SidebarMenuSub>
                      {folders.map((folder) => (
                        <SidebarMenuSubItem
                          key={folder.id}
                          className="group/folder relative"
                        >
                          <SidebarMenuSubButton
                            asChild
                            isActive={activeFolderId === folder.id}
                            className="pr-7"
                          >
                            <Link
                              href={`/dashboard/teacher?folder=${folder.id}`}
                            >
                              <Folder />
                              <span className="truncate">{folder.name}</span>
                              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {folder._count.exams}
                              </span>
                            </Link>
                          </SidebarMenuSubButton>
                          <FolderActions
                            folder={folder}
                            isActive={activeFolderId === folder.id}
                            onDeleted={() =>
                              setHiddenFolderIds((prev) =>
                                new Set(prev).add(folder.id)
                              )
                            }
                            onRenamed={(name) =>
                              setRenamedFolders((prev) => ({
                                ...prev,
                                [folder.id]: name,
                              }))
                            }
                          />
                        </SidebarMenuSubItem>
                      ))}
                      <SidebarMenuSubItem>
                        <NewFolderDialog />
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {role === "ADMIN" && (
          <>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === "/dashboard/admin"}
                    >
                      <Link href="/dashboard/admin">
                        <ShieldCheck data-icon="inline-start" />
                        <span>Admin-Bereich</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                <Avatar>
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {userName}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {userEmail}
                  </span>
                </div>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuItem
                onClick={() => {
                  void handleSignOut()
                }}
              >
                <LogOut data-icon="inline-start" />
                <span>Abmelden</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
