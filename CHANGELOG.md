# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Reworked the interface around the responsive Graphic Signal design system.
- Split the modular frontend into catalog, controller, and DOM view responsibilities.
- Reduced payload by removing legacy effects and duplicate implementations.

### Added
- Expanded browser coverage for search, filters, sorting, pagination, responsive layout, and error recovery.
- Added CI and GitHub Pages test gates before data updates and deployment.

### Security
- Replaced HTML string injection with safe rendering and explicit URL validation.
- Excluded private repositories from generated public catalog output as defense in depth.

## [1.0.0] - 2025-07-20

### Added
- 🔍 **Advanced Search**: Real-time search across repository names, descriptions, topics, and authors
- 🏷️ **Language Filtering**: Filter repositories by programming language with quick filter buttons
- 📊 **Multiple Sorting Options**: Sort by stars, name, update time, and creation date
- 📱 **Responsive Design**: Optimized for desktop, tablet, and mobile devices
- ⚡ **Performance Optimizations**: Debounced search, lazy loading, and smooth animations
- ♿ **Accessibility Features**: Full keyboard navigation and screen reader support
- 🎨 **Modern UI**: Clean design with smooth transitions and micro-interactions
- 📈 **Statistics Display**: Show total repositories, filtered count, and language statistics
- 🚀 **Repository Cards**: Rich repository information display with owner details
- 🔗 **External Links**: Direct links to GitHub repositories and project homepages
- 🏗️ **Language Categorization**: Group repositories by programming language
- 🎯 **Quick Filters**: Popular and recently used language filters
- 💾 **Local Storage**: Remember user preferences across sessions
- 🔄 **Loading States**: Skeleton screens and loading indicators
- ❌ **Error Handling**: Graceful error handling with retry functionality
- 📊 **Empty States**: Helpful messages when no results are found

### Browser Support
- Chrome 88+
- Firefox 85+
- Safari 14+
- Edge 88+
