-- Jade Shell's colorscheme, generated for the current theme ({{ name }}).
-- `:colorscheme jade`, or in LazyVim: { "LazyVim/LazyVim", opts = { colorscheme = "jade" } }.
-- Rewritten at every theme switch; Neovims using it follow at once.
vim.cmd("highlight clear")
if vim.g.syntax_on then vim.cmd("syntax reset") end
vim.g.colors_name = "jade"
vim.o.background = "{{ mode }}"

local c = {
  bg = "{{ background }}", bg_dark = "{{ dark_background }}", bg_darker = "{{ darker_background }}",
  bg_light = "{{ lighter_background }}", fg = "{{ foreground }}", fg_dark = "{{ dark_foreground }}",
  fg_light = "{{ light_foreground }}", fg_bright = "{{ bright_foreground }}", muted = "{{ muted }}",
  accent = "{{ accent }}", selection = "{{ selection_background }}", selection_fg = "{{ selection_foreground }}",
  red = "{{ red }}", orange = "{{ orange }}", yellow = "{{ yellow }}", green = "{{ green }}",
  cyan = "{{ cyan }}", blue = "{{ blue }}", magenta = "{{ magenta }}", brown = "{{ brown }}",
  bright_red = "{{ bright_red }}", bright_yellow = "{{ bright_yellow }}", bright_green = "{{ bright_green }}",
  bright_cyan = "{{ bright_cyan }}", bright_blue = "{{ bright_blue }}", bright_magenta = "{{ bright_magenta }}",
}

local function blend(a, b, t)
  local function channel(hex, i) return tonumber(hex:sub(i, i + 1), 16) end
  local out = "#"
  for _, i in ipairs({ 2, 4, 6 }) do
    out = out .. string.format("%02x", math.floor(channel(a, i) * (1 - t) + channel(b, i) * t + 0.5))
  end
  return out
end

local hl = function(group, spec) vim.api.nvim_set_hl(0, group, spec) end
local groups = {
  -- The editor
  Normal = { fg = c.fg, bg = c.bg }, NormalNC = { fg = c.fg, bg = c.bg },
  NormalFloat = { fg = c.fg, bg = c.bg_dark }, FloatBorder = { fg = c.accent, bg = c.bg_dark },
  FloatTitle = { fg = c.accent, bg = c.bg_dark, bold = true },
  Cursor = { fg = c.bg, bg = c.fg_bright }, CursorLine = { bg = c.bg_light }, CursorColumn = { bg = c.bg_light },
  ColorColumn = { bg = c.bg_light }, CursorLineNr = { fg = c.accent, bold = true }, LineNr = { fg = c.muted },
  SignColumn = { bg = c.bg }, FoldColumn = { fg = c.muted, bg = c.bg }, Folded = { fg = c.fg_dark, bg = c.bg_light },
  VertSplit = { fg = c.muted }, WinSeparator = { fg = c.muted }, EndOfBuffer = { fg = c.bg },
  NonText = { fg = c.muted }, Whitespace = { fg = c.muted }, SpecialKey = { fg = c.muted },
  Visual = { bg = c.selection }, VisualNOS = { bg = c.selection },
  Search = { fg = c.bg, bg = c.yellow }, IncSearch = { fg = c.bg, bg = c.accent }, CurSearch = { fg = c.bg, bg = c.accent },
  Substitute = { fg = c.bg, bg = c.red }, MatchParen = { fg = c.accent, bold = true, underline = true },
  Pmenu = { fg = c.fg, bg = c.bg_dark }, PmenuSel = { fg = c.bg, bg = c.accent, bold = true },
  PmenuSbar = { bg = c.bg_light }, PmenuThumb = { bg = c.muted }, PmenuKind = { fg = c.blue, bg = c.bg_dark },
  StatusLine = { fg = c.fg, bg = c.bg_dark }, StatusLineNC = { fg = c.fg_dark, bg = c.bg_dark },
  TabLine = { fg = c.fg_dark, bg = c.bg_dark }, TabLineFill = { bg = c.bg_dark }, TabLineSel = { fg = c.bg, bg = c.accent, bold = true },
  WinBar = { fg = c.fg, bold = true }, WinBarNC = { fg = c.fg_dark },
  Title = { fg = c.accent, bold = true }, Directory = { fg = c.blue },
  ErrorMsg = { fg = c.red, bold = true }, WarningMsg = { fg = c.yellow }, ModeMsg = { fg = c.accent, bold = true },
  MoreMsg = { fg = c.green }, Question = { fg = c.green }, QuickFixLine = { bg = c.bg_light, bold = true },
  WildMenu = { fg = c.bg, bg = c.accent }, SpellBad = { sp = c.red, undercurl = true },
  SpellCap = { sp = c.yellow, undercurl = true }, SpellRare = { sp = c.magenta, undercurl = true },
  SpellLocal = { sp = c.cyan, undercurl = true },

  -- Syntax
  Comment = { fg = c.fg_dark, italic = true }, Constant = { fg = c.orange }, String = { fg = c.green },
  Character = { fg = c.green }, Number = { fg = c.orange }, Boolean = { fg = c.orange }, Float = { fg = c.orange },
  Identifier = { fg = c.fg }, Function = { fg = c.blue }, Statement = { fg = c.magenta }, Conditional = { fg = c.magenta },
  Repeat = { fg = c.magenta }, Label = { fg = c.magenta }, Operator = { fg = c.cyan }, Keyword = { fg = c.magenta },
  Exception = { fg = c.red }, PreProc = { fg = c.cyan }, Include = { fg = c.magenta }, Define = { fg = c.magenta },
  Macro = { fg = c.cyan }, Type = { fg = c.yellow }, StorageClass = { fg = c.yellow }, Structure = { fg = c.yellow },
  Typedef = { fg = c.yellow }, Special = { fg = c.accent }, SpecialChar = { fg = c.cyan }, Tag = { fg = c.blue },
  Delimiter = { fg = c.fg_light }, SpecialComment = { fg = c.fg_dark, italic = true }, Debug = { fg = c.red },
  Underlined = { underline = true }, Error = { fg = c.red }, Todo = { fg = c.bg, bg = c.yellow, bold = true },

  -- Tree-sitter
  ["@variable"] = { fg = c.fg }, ["@variable.builtin"] = { fg = c.red }, ["@variable.parameter"] = { fg = c.fg_light },
  ["@variable.member"] = { fg = c.cyan }, ["@property"] = { fg = c.cyan }, ["@constant"] = { fg = c.orange },
  ["@constant.builtin"] = { fg = c.orange }, ["@module"] = { fg = c.yellow }, ["@string"] = { fg = c.green },
  ["@string.escape"] = { fg = c.cyan }, ["@string.regexp"] = { fg = c.cyan }, ["@character"] = { fg = c.green },
  ["@number"] = { fg = c.orange }, ["@boolean"] = { fg = c.orange }, ["@type"] = { fg = c.yellow },
  ["@type.builtin"] = { fg = c.yellow }, ["@attribute"] = { fg = c.cyan }, ["@function"] = { fg = c.blue },
  ["@function.builtin"] = { fg = c.cyan }, ["@function.method"] = { fg = c.blue }, ["@constructor"] = { fg = c.yellow },
  ["@keyword"] = { fg = c.magenta }, ["@keyword.return"] = { fg = c.magenta, bold = true },
  ["@keyword.function"] = { fg = c.magenta }, ["@operator"] = { fg = c.cyan }, ["@punctuation"] = { fg = c.fg_light },
  ["@punctuation.bracket"] = { fg = c.fg_light }, ["@comment"] = { link = "Comment" }, ["@tag"] = { fg = c.blue },
  ["@tag.attribute"] = { fg = c.cyan }, ["@tag.delimiter"] = { fg = c.fg_dark },
  ["@markup.heading"] = { fg = c.accent, bold = true }, ["@markup.strong"] = { bold = true },
  ["@markup.italic"] = { italic = true }, ["@markup.link"] = { fg = c.blue, underline = true },
  ["@markup.raw"] = { fg = c.green }, ["@markup.list"] = { fg = c.accent },

  -- Diagnostics and LSP
  DiagnosticError = { fg = c.red }, DiagnosticWarn = { fg = c.yellow }, DiagnosticInfo = { fg = c.blue },
  DiagnosticHint = { fg = c.cyan }, DiagnosticOk = { fg = c.green },
  DiagnosticUnderlineError = { sp = c.red, undercurl = true }, DiagnosticUnderlineWarn = { sp = c.yellow, undercurl = true },
  DiagnosticUnderlineInfo = { sp = c.blue, undercurl = true }, DiagnosticUnderlineHint = { sp = c.cyan, undercurl = true },
  DiagnosticVirtualTextError = { fg = c.red, bg = blend(c.bg, c.red, 0.1) },
  DiagnosticVirtualTextWarn = { fg = c.yellow, bg = blend(c.bg, c.yellow, 0.1) },
  DiagnosticVirtualTextInfo = { fg = c.blue, bg = blend(c.bg, c.blue, 0.1) },
  DiagnosticVirtualTextHint = { fg = c.cyan, bg = blend(c.bg, c.cyan, 0.1) },
  LspReferenceText = { bg = c.bg_light }, LspReferenceRead = { bg = c.bg_light }, LspReferenceWrite = { bg = c.bg_light },
  LspInlayHint = { fg = c.muted, italic = true },

  -- Diffs and git
  DiffAdd = { bg = blend(c.bg, c.green, 0.18) }, DiffChange = { bg = blend(c.bg, c.blue, 0.14) },
  DiffDelete = { bg = blend(c.bg, c.red, 0.18) }, DiffText = { bg = blend(c.bg, c.blue, 0.32) },
  Added = { fg = c.green }, Changed = { fg = c.blue }, Removed = { fg = c.red },
  GitSignsAdd = { fg = c.green }, GitSignsChange = { fg = c.blue }, GitSignsDelete = { fg = c.red },

  -- Popular plugins
  TelescopeBorder = { fg = c.accent, bg = c.bg_dark }, TelescopeNormal = { fg = c.fg, bg = c.bg_dark },
  TelescopeSelection = { bg = c.bg_light, bold = true }, TelescopeMatching = { fg = c.accent, bold = true },
  SnacksPickerMatch = { fg = c.accent, bold = true }, SnacksDashboardHeader = { fg = c.accent },
  WhichKey = { fg = c.accent }, WhichKeyDesc = { fg = c.fg }, WhichKeyGroup = { fg = c.blue },
  NeoTreeNormal = { fg = c.fg, bg = c.bg_dark }, NeoTreeNormalNC = { fg = c.fg, bg = c.bg_dark },
  NeoTreeDirectoryName = { fg = c.blue }, NeoTreeRootName = { fg = c.accent, bold = true },
  NvimTreeNormal = { fg = c.fg, bg = c.bg_dark }, NvimTreeFolderName = { fg = c.blue },
  IblIndent = { fg = c.bg_light }, IblScope = { fg = c.muted },
  MiniIndentscopeSymbol = { fg = c.accent }, FlashLabel = { fg = c.bg, bg = c.accent, bold = true },
  NoiceCmdlinePopupBorder = { fg = c.accent }, NotifyBackground = { bg = c.bg_dark },
  BlinkCmpMenu = { fg = c.fg, bg = c.bg_dark }, BlinkCmpMenuSelection = { fg = c.bg, bg = c.accent },
  BlinkCmpMenuBorder = { fg = c.accent, bg = c.bg_dark },
}
for group, spec in pairs(groups) do hl(group, spec) end

-- The terminal's sixteen colors.
for i, color in ipairs({ c.bg, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.fg, c.muted, c.bright_red,
  c.bright_green, c.bright_yellow, c.bright_blue, c.bright_magenta, c.bright_cyan, c.fg_bright }) do
  vim.g["terminal_color_" .. (i - 1)] = color
end
