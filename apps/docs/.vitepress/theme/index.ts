import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import CustomLayout from "./CustomLayout.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: CustomLayout,
} satisfies Theme;
