import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const fileUrl = 'file:///' + path.resolve('C:/Users/adima/.gemini/antigravity/brain/1bc8b9bc-1c45-4415-ad5a-29c3cdb07f58/scratch/part_1.html').replace(/\\/g, '/');
  await page.goto(fileUrl);
  
  const modules = await page.evaluate(() => {
    // PASTE EXACT LOGIC FROM buildSidebarHierarchy
    const getSidebar = () => {
         const trees = document.querySelectorAll('[role="tree"], ul.el-menu, .sidebar, aside, .menu, .left-menu');
         for (const t of trees) {
             if (/Course Introduction/i.test(t.textContent) || /WLAN/i.test(t.textContent)) return t;
         }
         const all = document.querySelectorAll('*');
         for (const n of all) {
             const txt = n.textContent.trim();
             if (txt.length < 100 && (/Course Introduction/i.test(txt) || /^\d+\.?\s/i.test(txt))) {
                 const container = n.closest('ul, [role="tree"], .sidebar, aside, .menu, .left-menu');
                 if (container) return container;
                 let p = n;
                 for (let i = 0; i < 4; i++) { if (p.parentElement) p = p.parentElement; }
                 return p;
             }
         }
         return document.body;
    };
    
    const sidebar = getSidebar();
    const modules = [];
    const nodes = Array.from(sidebar.querySelectorAll('[role="treeitem"], li, .el-menu-item, .el-submenu__title, .tree-node'));
    let currentModule = null;

    const blocklist = ['English', 'Français', 'العربية', 'Español', 'Português', 'Italiano', 'Deutsch', 'Türk', 'Русский', '日本語', 'ไทย', 'Bahasa malaysia', 'Indonesia', 'Filipino', 'اردو', 'Қазақша', 'Polski', 'Nederlands', 'Original'];

    const cleanText = (el) => {
        const titleEl = el.querySelector('p.text, .el-tree-node__label, span[title]');
        if (titleEl && titleEl.getAttribute('title')) return titleEl.getAttribute('title').trim();
        if (titleEl) return titleEl.textContent.replace(/\s+/g, ' ').trim();
        
        let directText = '';
        for (const child of (el.querySelector('.tree-node-content, .el-submenu__title') || el).childNodes) {
            if (child.nodeType === 3) directText += child.textContent;
        }
        if (directText.trim()) return directText.replace(/\s+/g, ' ').trim();
        return el.textContent.replace(/\s+/g, ' ').trim();
    };

    for (const node of nodes) {
       const text = cleanText(node);
       if (!text || text.length < 3 || text.length > 80) continue; 
       if (blocklist.includes(text)) continue;

       const isLevel1 = /^\d+\.?\s+[a-zA-Z]/i.test(text) || /^Course Introduction/i.test(text) || /^Final Exam/i.test(text);
       const isLevel2 = /^\d+\.\d+\s+/i.test(text) || /^Introduction to/i.test(text);
       
       const hasPlayIcon = node.querySelector('i[class*="play"], i[class*="video"], svg path[d*="M8 5v14l11-7z"]') !== null;
       const hasDocIcon = node.querySelector('i[class*="document"], i[class*="file"], i[class*="text"]') !== null;
       
       const hasChildren = node.querySelector('ul, .el-menu, [role="group"]') !== null || node.getAttribute('aria-expanded') !== null || node.querySelector('.tree-node-children') !== null;
       const isLeaf = !hasChildren || hasPlayIcon || hasDocIcon;

       if (isLevel1 && !isLeaf) {
         if (!currentModule || currentModule.moduleTitle !== text) {
             currentModule = { moduleTitle: text, lessons: [] };
             modules.push(currentModule);
         }
       } else if (isLeaf) {
         if (!currentModule) {
           currentModule = { moduleTitle: 'Uncategorized', lessons: [] };
           modules.push(currentModule);
         }
         const lastLesson = currentModule.lessons[currentModule.lessons.length - 1];
         if (!lastLesson || lastLesson.lessonTitle !== text) {
             currentModule.lessons.push({ lessonTitle: text });
         }
       }
    }
    return modules;
  });

  console.log(JSON.stringify(modules, null, 2));
  await browser.close();
})();
