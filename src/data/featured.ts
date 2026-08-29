export interface FeaturedProject {
  nameWithOwner: string;
  summary: string;
  contribution: string;
}

export const featuredProjects = [
  {
    nameWithOwner: "dev-zetta/mkv-muxing-batch-gui",
    summary:
      "A maintained PySide6 desktop workflow for reliable batch MKV muxing, with release hardening around media safety and cross-platform packaging.",
    contribution:
      "Maintained fork · safer replacement paths, queue recovery, packaging, and release validation",
  },
  {
    nameWithOwner: "dev-zetta/sacd_extract2",
    summary:
      "A cross-platform SACD extraction toolchain spanning native C, archival DSF/DSDIFF/FLAC output, damaged-media recovery, and desktop packaging.",
    contribution:
      "Maintained fork · extraction reliability, recovery paths, metadata, GUI, and multi-platform releases",
  },
  {
    nameWithOwner: "dev-zetta/aoostar-rs",
    summary:
      "Rust-based display control for AOOSTAR WTR MAX and GEM12+ Pro systems, including configuration and Proxmox-focused deployment work.",
    contribution:
      "Contributed fork · device support, configuration, and deployment refinements",
  },
  {
    nameWithOwner: "dev-zetta/PicoGhostHID",
    summary:
      "Native TinyUSB firmware for Pico 1 and Pico 2 that produces configurable, randomized USB HID keyboard and mouse activity without a host application.",
    contribution:
      "Original project · firmware architecture, device behavior, builds, and documentation",
  },
  {
    nameWithOwner: "dev-zetta/GameModdingStudio",
    summary:
      "A long-running Pascal toolkit for inspecting, extracting, and converting game assets, prepared for public release after fourteen years of private development.",
    contribution:
      "Original project · archival release, format coverage, tooling, and documentation",
  },
  {
    nameWithOwner: "zetta-app/llama.cpp_turboquant",
    summary:
      "GPU architecture-specific build tooling for a llama.cpp and TurboQuant inference workspace targeting long-context local AI on constrained VRAM.",
    contribution:
      "External repository · initial workspace and GPU-specific build automation",
  },
] as const satisfies readonly FeaturedProject[];

export const featuredNames = new Set(
  featuredProjects.map((project) => project.nameWithOwner),
);
