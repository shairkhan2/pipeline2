"use client"

import * as React from "react"
import { CheckIcon, SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group"

interface CommandContextValue {
  search: string
  setSearch: (value: string) => void
  visibleCount: number
  registerMatch: (id: string, matched: boolean) => void
  unregisterMatch: (id: string) => void
}

const CommandContext = React.createContext<CommandContextValue | null>(null)

function Command({ className, children, ...props }: React.ComponentProps<"div">) {
  const [search, setSearch] = React.useState("")
  const matchesRef = React.useRef<Map<string, boolean>>(new Map())
  const [visibleCount, setVisibleCount] = React.useState(0)

  const syncCount = React.useCallback(() => {
    let count = 0
    for (const v of matchesRef.current.values()) {
      if (v) count++
    }
    setVisibleCount(count)
  }, [])

  const registerMatch = React.useCallback(
    (id: string, matched: boolean) => {
      if (matchesRef.current.get(id) === matched) return
      matchesRef.current.set(id, matched)
      syncCount()
    },
    [syncCount]
  )

  const unregisterMatch = React.useCallback(
    (id: string) => {
      if (!matchesRef.current.has(id)) return
      matchesRef.current.delete(id)
      syncCount()
    },
    [syncCount]
  )

  const ctx = React.useMemo<CommandContextValue>(
    () => ({ search, setSearch, visibleCount, registerMatch, unregisterMatch }),
    [search, visibleCount, registerMatch, unregisterMatch]
  )

  return (
    <CommandContext.Provider value={ctx}>
      <div
        data-slot="command"
        className={cn(
          "flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </CommandContext.Provider>
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-xl p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  value,
  onChange,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<"input">, "onChange"> & {
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  onValueChange?: (value: string) => void
}) {
  const ctx = React.useContext(CommandContext)
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8 rounded-lg border-input/30 bg-input/30 shadow-none *:data-[slot=input-group-addon]:pl-2">
        <input
          data-slot="command-input"
          value={value ?? ctx?.search ?? ""}
          onChange={(e) => {
            ctx?.setSearch(e.target.value)
            onValueChange?.(e.target.value)
            onChange?.(e)
          }}
          className={cn(
            "w-full bg-transparent px-2 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-list"
      role="listbox"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({ className, ...props }: React.ComponentProps<"div">) {
  const ctx = React.useContext(CommandContext)
  if (!ctx || (ctx.search.trim() !== "" && ctx.visibleCount > 0) || ctx.search.trim() === "") {
    if (ctx && ctx.visibleCount > 0) return null
  }
  return (
    <div
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  heading?: React.ReactNode
}) {
  return (
    <div
      data-slot="command-group"
      role="group"
      className={cn("overflow-hidden p-1 text-foreground", className)}
      {...props}
    >
      {heading != null && (
        <div
          cmdk-group-heading=""
          className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
        >
          {heading}
        </div>
      )}
      {children}
    </div>
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-separator"
      role="separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  value,
  disabled,
  onSelect,
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  value?: string
  disabled?: boolean
  onSelect?: (value: string) => void
}) {
  const ctx = React.useContext(CommandContext)
  const id = React.useId()
  const search = ctx?.search.trim().toLowerCase() ?? ""
  const itemValue = (value ?? "").toLowerCase()
  const matched = !search || !itemValue || itemValue.includes(search)

  React.useLayoutEffect(() => {
    ctx?.registerMatch(id, matched)
    return () => ctx?.unregisterMatch(id)
  }, [ctx, id, matched])

  if (!matched) return null

  return (
    <div
      data-slot="command-item"
      role="option"
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) return
        onClick?.(e)
        onSelect?.(value ?? "")
      }}
      className={cn(
        "group/command-item relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-muted hover:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </div>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
