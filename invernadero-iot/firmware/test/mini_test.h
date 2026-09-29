/* mini_test.h - arnes de pruebas minimo, sin dependencias.
   CHECK(cond)          falla si cond es falsa (y sigue con la siguiente)
   CHECK_EQ(a, b)       compara enteros (imprime ambos valores si difieren)
   CHECK_STR(a, b)      compara cadenas C
   CHECK_NEAR(a, b, e)  compara decimales con tolerancia
   TEST(nombre) { ... } registra una prueba; main() = return correr();  */
#ifndef MINI_TEST_H
#define MINI_TEST_H

#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <vector>

struct MiniTest {
  struct Caso { const char* nombre; void (*f)(); };
  static std::vector<Caso>& casos() { static std::vector<Caso> v; return v; }
  static int& fallas() { static int n = 0; return n; }
  static int& comprobaciones() { static int n = 0; return n; }
  static const char*& actual() { static const char* s = ""; return s; }
  static bool registrar(const char* n, void (*f)()) { casos().push_back({n, f}); return true; }
};

#define CHECK(cond) do { MiniTest::comprobaciones()++; if (!(cond)) { MiniTest::fallas()++; \
  printf("  FALLA [%s] %s:%d  CHECK(%s)\n", MiniTest::actual(), __FILE__, __LINE__, #cond); } } while (0)

#define CHECK_EQ(a, b) do { MiniTest::comprobaciones()++; long long _a = (long long)(a), _b = (long long)(b); \
  if (_a != _b) { MiniTest::fallas()++; printf("  FALLA [%s] %s:%d  %s == %s  (%lld vs %lld)\n", \
  MiniTest::actual(), __FILE__, __LINE__, #a, #b, _a, _b); } } while (0)

#define CHECK_STR(a, b) do { MiniTest::comprobaciones()++; const char* _a = (a); const char* _b = (b); \
  if (!_a || !_b || strcmp(_a, _b) != 0) { MiniTest::fallas()++; printf("  FALLA [%s] %s:%d  %s == %s  (\"%s\" vs \"%s\")\n", \
  MiniTest::actual(), __FILE__, __LINE__, #a, #b, _a ? _a : "(null)", _b ? _b : "(null)"); } } while (0)

#define CHECK_NEAR(a, b, e) do { MiniTest::comprobaciones()++; double _a = (double)(a), _b = (double)(b); \
  if (!(fabs(_a - _b) <= (double)(e))) { MiniTest::fallas()++; printf("  FALLA [%s] %s:%d  %s ~ %s  (%g vs %g)\n", \
  MiniTest::actual(), __FILE__, __LINE__, #a, #b, _a, _b); } } while (0)

#define TEST(nombre) static void nombre(); static bool _reg_##nombre = MiniTest::registrar(#nombre, nombre); static void nombre()

static int correr() {
  for (auto& c : MiniTest::casos()) {
    MiniTest::actual() = c.nombre;
    const int antes = MiniTest::fallas();
    c.f();
    printf("%s %s\n", MiniTest::fallas() == antes ? "  ok   " : "  FALLO", c.nombre);
  }
  printf("\n%d pruebas, %d comprobaciones, %d fallas\n", (int)MiniTest::casos().size(), MiniTest::comprobaciones(), MiniTest::fallas());
  return MiniTest::fallas() ? 1 : 0;
}

#endif  // MINI_TEST_H
