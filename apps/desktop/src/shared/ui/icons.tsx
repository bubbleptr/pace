import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import {
  ActivityIcon,
  AddIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUp02Icon,
  BarChartIcon,
  BotIcon,
  BoxIcon,
  Cancel01Icon,
  ChatAddIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  CommandIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CrosshairIcon,
  Delete02Icon,
  File01Icon,
  FileDiffIcon,
  Files01Icon,
  FlashIcon,
  Folder01Icon,
  Folder02Icon,
  FolderLibraryIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Globe02Icon,
  ImageIcon as HugeImageIcon,
  LayoutAlignLeftIcon,
  LinkSquare02Icon,
  ListTreeIcon,
  Loading03Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  PuzzleIcon,
  RefreshIcon,
  RobotIcon,
  Search01Icon,
  Settings01Icon,
  Settings02Icon,
  SidebarLeftIcon,
  SparklesIcon,
  StopIcon as HugeStopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Tick02Icon,
  UserIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";

type PaceIconProps = Omit<HugeiconsIconProps, "icon" | "altIcon">;

const paceIconStrokeWidth = 1.5;

function iconComponent(icon: IconSvgElement) {
  return function PaceIcon(props: PaceIconProps) {
    return (
      <HugeiconsIcon
        color="currentColor"
        icon={icon}
        strokeWidth={paceIconStrokeWidth}
        {...props}
      />
    );
  };
}

export const Activity = iconComponent(ActivityIcon);
export const Archive = iconComponent(ArchiveIcon);
export const ArrowLeft = iconComponent(ArrowLeftIcon);
export const ArrowRight = iconComponent(ArrowRightIcon);
export const ArrowUp = iconComponent(ArrowUp02Icon);
export const BarChart3 = iconComponent(BarChartIcon);
export const Bot = iconComponent(RobotIcon);
export const Box = iconComponent(BoxIcon);
export const Cancel = iconComponent(Cancel01Icon);
export const ChatAdd = iconComponent(ChatAddIcon);
export const ChevronDown = iconComponent(ChevronDownIcon);
export const ChevronRight = iconComponent(ChevronRightIcon);
export const Check = iconComponent(Tick02Icon);
export const Circle = iconComponent(CircleIcon);
export const Command = iconComponent(CommandIcon);
export const Computer = iconComponent(ComputerIcon);
export const Copy = iconComponent(Copy01Icon);
export const Crosshair = iconComponent(CrosshairIcon);
// Not `File`: that name is the host File constructor, and some Vite/HMR
// transforms bind the export to it. IconsGallery then renders the constructor
// and React 19 throws "Cannot read properties of null (reading 'use')".
export const FileIcon = iconComponent(File01Icon);
export const FileDiff = iconComponent(FileDiffIcon);
export const Files = iconComponent(Files01Icon);
export const Flash = iconComponent(FlashIcon);
export const FolderClosed = iconComponent(Folder01Icon);
export const FolderLibrary = iconComponent(FolderLibraryIcon);
export const FolderOpen = iconComponent(FolderOpenIcon);
export const FolderOpenState = iconComponent(Folder02Icon);
export const GitBranch = iconComponent(GitBranchIcon);
export const Globe = iconComponent(Globe02Icon);
export const ImageIcon = iconComponent(HugeImageIcon);
export const LinkExternal = iconComponent(LinkSquare02Icon);
export const LayoutAlignLeft = iconComponent(LayoutAlignLeftIcon);
export const ListTree = iconComponent(ListTreeIcon);
export const LoaderCircle = iconComponent(Loading03Icon);
export const MoreHorizontal = iconComponent(MoreHorizontalIcon);
export const Palette = iconComponent(PaintBoardIcon);
export const Pencil = iconComponent(PencilEdit01Icon);
export const Plus = iconComponent(AddIcon);
export const Puzzle = iconComponent(PuzzleIcon);
export const RefreshCw = iconComponent(RefreshIcon);
export const Search = iconComponent(Search01Icon);
export const Settings = iconComponent(Settings01Icon);
export const Settings2 = iconComponent(Settings02Icon);
export const SidebarLeft = iconComponent(SidebarLeftIcon);
export const Sparkles = iconComponent(SparklesIcon);
export const Stop = iconComponent(HugeStopIcon);
// Lucide SquareTerminal: framed console with a prompt. Hugeicons names
// that glyph ComputerTerminal01; the unframed TerminalIcon stays unused.
export const SquareTerminal = iconComponent(ComputerTerminal01Icon);
export const Terminal = SquareTerminal;
export const ThumbsDown = iconComponent(ThumbsDownIcon);
export const ThumbsUp = iconComponent(ThumbsUpIcon);
export const Trash2 = iconComponent(Delete02Icon);
export const User = iconComponent(UserIcon);
export const Wrench = iconComponent(WrenchIcon);

// Keep the plain bot glyph available for places that need a chat-specific robot icon.
export const BotMessage = iconComponent(BotIcon);

export {
  AnimatedChartPie,
  AnimatedFile,
  AnimatedHistory,
  AnimatedInformationCircle,
  AnimatedKey,
  AnimatedMessage,
  AnimatedMoreHorizontal,
  AnimatedNewChat,
  AnimatedPlus,
  AnimatedPuzzle,
  AnimatedRobot,
  AnimatedSettings,
  AnimatedSidebar,
  AnimatedSidebarRight,
  type AnimatedIconProps,
} from "./animated-icons";
