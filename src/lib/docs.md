# Mavka Language Cheat Sheet & Critical Constraints
*Target Version: 0.124.1+*

## ⚠️ CRITICAL COMPILER RULES (STRICT ENFORCEMENT)

### 1. Variables & Naming
*   **CYRILLIC ONLY:** All variable and function names **MUST** use Ukrainian Cyrillic.
*   **NO LATIN CHARS:** Do not use `i`, `x`, `y`, `t`, `n` even as single letters. Use `і`, `х`, `у`, `т`, `н`.
*   **Syntax:** Dynamic typing.
    ```mavka
    імʼя = "Мавка"
    число = 10
    список = [1, 2, 3]
    є_активним = дійсне
    ```

### 2. Broken Features (DO NOT USE)
*   ❌ **Operator `та` (AND):** Broken parser. Use nested `якщо`.
*   ❌ **`вернути` inside `перебрати`:** Causes runtime errors. Use **Accumulator Pattern** (flags/vars).
*   ❌ **Standard Library (`взяти біб`):** Unreliable. Implement math functions manually.
*   ❌ **Em Dash (`—`):** Breaks encoding. Use hyphen (`-`) or double hyphen (`--`).
*   ❌ **Implicit Returns:** Always use a final catch-all `вернути` or explicit `інакше`.

---

## 🛠 SYNTAX & SAFE PATTERNS

### Function Definition
*   Define `дія` first, call `друк` at the bottom.
*   **Rule:** Always calculate math into variables before returning.

```mavka
дія сума_чисел(а, б)
  результат = а + б
  вернути результат
кінець

друк(сума_чисел(5, 10))
```

### Conditional Logic (The "Nested If" Rule)
*   **Reason:** The `та` operator is broken.
*   **Reason:** Math inside `якщо` conditions is unstable.

```mavka
дія перевірка(число)
  половина = число / 2
  якщо число > 10
    якщо половина < 20
      вернути "Підходить"
    кінець
  кінець
  вернути "Не підходить"
кінець
```

### Loops (The "Accumulator" Rule)
*   **Syntax:** Must use `перебрати ... як ...`. (Do not use `в` or `in`).
*   **Logic:** Never return inside the loop. Update a variable, break logic manually if needed, return at end.

```mavka
дія знайти_максимум(список)
  максимум = 0
  перебрати список як елемент
    якщо елемент > максимум
      максимум = елемент
    кінець
  кінець
  вернути максимум
кінець
```

### Lists & Arrays
*   **Property:** Use `.розмір` (no parentheses).
*   **Methods:** `.додати()`, `.отримати()`.

```mavka
список = [10, 20]
розмір = список.розмір
список.додати(30)
перший = список[0]
```

---

## 🧮 MATH & ALGORITHMS WORKAROUNDS

### Safe Arithmetic
*   **Division:** Always check for 0.
*   **Comparisons:** Pre-calculate math to intermediate variables.
*   **Ceiling (Math.ceil):** Implement manually using modulo.

```mavka
дія безпечне_ділення(а, б)
  якщо б != 0
    результат = а / б
    вернути результат
  інакше
    вернути 0
  кінець
кінець
```

### Manual Ceiling Division (No Library)
```mavka
дія стеля(чисельник, знаменник)
  остача = чисельник % знаменник
  ціле = чисельник - остача
  результат = ціле / знаменник
  якщо остача > 0
    результат = результат + 1
  кінець
  вернути результат
кінець
```

---

## 📝 TEMPLATE: ROBUST ALGORITHM STRUCTURE

Use this structure to avoid all known parser bugs:

```mavka
дія головна_функція(вхідний_список)
  поточний_результат = 0
  знайдено = недійсне
  
  перебрати вхідний_список як елемент
    обчислення = елемент * 2
    
    якщо знайдено == недійсне
      якщо обчислення > 100
        поточний_результат = елемент
        знайдено = дійсне
      кінець
    кінець
  кінець
  
  якщо знайдено
    вернути поточний_результат
  інакше
    вернути -1
  кінець
кінець

дані = [10, 55, 2]
друк(головна_функція(дані))
```
```
