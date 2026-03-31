import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface NavItem {
    name: string
    url: string
    icon: LucideIcon
}

interface NavBarProps {
    items: NavItem[]
    className?: string
    activeTab: string
    setActiveTab: (tab: string) => void
}

export function NavBar({ items, className, activeTab, setActiveTab }: NavBarProps) {
    const [, setIsMobile] = useState(false)

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768)
        }

        handleResize()
        window.addEventListener("resize", handleResize)
        return () => window.removeEventListener("resize", handleResize)
    }, [])

    return (
        <nav className="fixed top-0 w-full z-50 flex items-center justify-between px-6 h-16 bg-[#18181b] ">
            <div className="flex items-center gap-8">
                <span className="text-xl font-bold text-slate-100 tracking-tighter">Kendall</span>
            </div>
            
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 backdrop-blur-lg py-1 px-1 rounded-full shadow-lg">
                {items.map((item) => {
                    const Icon = item.icon
                    const isActive = activeTab === item.name

                    return (
                        <a
                            key={item.name}
                            onClick={(e) => { e.preventDefault(); setActiveTab(item.name); }}
                            href="#"
                            className={cn(
                                "relative cursor-pointer text-sm font-semibold rounded-full transition-colors bg-transparent px-5 py-2",
                                "text-gray-400 hover:text-white",
                                isActive ? "text-white" : ""
                            )}
                        >
                            <span className="hidden md:inline text-white">{item.name}</span>
                            <span className="md:hidden">
                                <Icon size={18} strokeWidth={2.5} />
                            </span>
                            {isActive && (
                                <motion.div
                                    layoutId="lamp"
                                    className="absolute inset-0 w-full bg-[#191919] rounded-full -z-10"
                                    initial={false}
                                    transition={{
                                        type: "spring",
                                        stiffness: 300,
                                        damping: 30,
                                    }}
                                ></motion.div>
                            )}
                        </a>
                    )
                })}
            </div>
        </nav>
    )
}