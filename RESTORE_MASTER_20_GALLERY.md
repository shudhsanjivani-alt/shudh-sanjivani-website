# Stage 139 — Master 20-image gallery restore

Source of truth: `PDF_Gallery_20_Original_Product_Images_2026-09-17.pdf` (20 pages).

This checkpoint is based on `stage138-restore-safe`. `main` is intentionally untouched.

## Master mapping
1. Sendha/Rock Salt → `assets/products/rock-salt.jpg`
2. Salem Fali Turmeric Powder → `assets/products/pdf-salem-fali-haldi.jpg`
3. Cardamom Powder → `assets/products/cardamom-powder.jpg`
4. Black Salt → `assets/products/black-salt.jpg`
5. Red Chilli Powder → `assets/products/red-chilli-powder.png`
6. Dry Ginger/Sonth Powder → `assets/products/dry-ginger-powder.png`
7. Fennel Seeds → `assets/products/fennel-seeds.png`
8. Black Pepper Powder → `assets/products/black-pepper-powder.png`
9. White Pepper Powder → `assets/products/white-pepper-powder.png`
10. Cumin Powder → `assets/products/cumin-powder.jpg`
11. Whole Spices/Khada Masala → `assets/products/whole-spices.png`
12. Whole Cumin → `assets/products/cumin-whole.png`
13. Cloves → `assets/products/cloves.jpg`
14. Amchur Powder → `assets/products/amchur-powder.png`
15. Dalia → `assets/products/dalia.jpg`
16. Green Cardamom → `assets/products/green-cardamom.png`
17. Cinnamon Powder → `assets/products/cinnamon-powder.jpg`
18. Ajwain/Carom Seeds → `assets/products/carom-seeds.png`
19. Garam Masala Powder → `assets/products/garam-masala.jpg`
20. Mulethi Powder → `assets/products/mulethi-powder.png`

## Black-background rule
The master PDF's Black Salt image contains an intentional black background and must not be made transparent. Any separate black-background artifact caused by PNG conversion should be replaced by the verified master asset rather than corrected with CSS filters.

## Deployment rule
Do not merge to `main` or trigger Cloudflare deployment until the 20 image URLs and binary assets pass the final audit.
