import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://cakelisten-edking.ykkjttytcj.chatgpt.site"),
  alternates: { canonical: "/" },
  title: "CAKE Monitor · PancakeSwap 数据终端",
  description: "追踪 PancakeSwap 的协议活动、CAKE 产品销毁、净通缩、供应变化与价格提醒。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
