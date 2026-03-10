# Contributing to Claude SWE Agent

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/timtran1/claude-swe.git
   cd claude-swe
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Code Style

We use the following tools to maintain code quality:

- **TypeScript** for type safety
- **ESLint** for linting

Before committing, ensure your code passes all checks:

```bash
npm run lint    # Run linting
npm test        # Run tests
npm run build   # Verify TypeScript compiles
```

### Commit Messages

Follow conventional commit format:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `test:` Test additions or changes
- `refactor:` Code refactoring
- `chore:` Maintenance tasks

Example:
```
feat: add support for GitLab webhooks
```

## Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all tests pass and TypeScript compiles cleanly
4. Submit PR with a clear description of changes

## Code Review

- PRs require at least one approval
- Address all review comments
- Keep PRs focused and reasonably sized

## Questions?

Open an issue for questions or discussions about contributions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
