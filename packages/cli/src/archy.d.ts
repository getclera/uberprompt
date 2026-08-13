declare module "archy" {
  interface ArchyNode {
    label: string;
    nodes?: (ArchyNode | string)[];
  }
  export default function archy(
    node: ArchyNode | string,
    prefix?: string,
    opts?: Record<string, unknown>
  ): string;
}
