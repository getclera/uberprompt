<script setup>
import DefaultTheme from "vitepress/theme";
import BrandTitle from "./BrandTitle.vue";

const { Layout } = DefaultTheme;
</script>
<template>
  <Layout>
    <template #nav-bar-title-before>
      <BrandTitle />
    </template>
  </Layout>
</template>
